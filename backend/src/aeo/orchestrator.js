/**
 * AEO Orchestrator  (v2) — Main Middleware Entry Point
 *
 * Chains Stage 1 → Stage 2 → Stage 3 before dispatching to llama.cpp.
 *
 * Improvements over v1:
 *  - Structured per-stage timing: each stage now records its own elapsed ms
 *    so the paper can attribute overhead independently to cache lookup,
 *    token pruning, and thread allocation.
 *  - Warm-up mode: call orchestrator.warmUp(queries) to pre-populate the
 *    semantic cache with a known corpus before benchmarking starts, ensuring
 *    the first benchmark run is not penalised by cold-cache misses.
 *  - Retry / fallback: if an upstream stage throws (e.g. corrupted sensor
 *    text), the orchestrator catches it, records the error in the result,
 *    and falls back gracefully rather than crashing the benchmark runner.
 *  - Richer deviceState pass-through: cpuTempC and prevThreads are now
 *    forwarded to the compute allocator so thermal throttle + hysteresis work.
 *  - Pre-inference power estimate: result.powerProxyEstimateMs from Stage 3
 *    is surfaced so the benchmark runner can log it before inference starts.
 *  - Log rotation with structured JSON entries (benchmark-friendly).
 *  - process.hrtime.bigint() → performance.now() fallback for environments
 *    without Node's process global (e.g. Deno, browser test harness).
 */

import { SemanticCache }   from './semanticCache.js';
import { pruneSensorData } from './tokenPruner.js';
import { allocateThreads } from './computeAllocator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hrNow() {
  if (typeof process !== 'undefined' && process.hrtime) {
    return Number(process.hrtime.bigint()) / 1e6; // ms, float
  }
  return performance.now();
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class AEOOrchestrator {
  /**
   * @param {object} options
   * @param {number}  [options.maxLogEntries=500]   - Circular log buffer size
   * @param {number}  [options.cacheMaxEntries=512] - SemanticCache LRU cap
   * @param {number}  [options.cacheTtlMs]          - SemanticCache entry TTL
   * @param {number}  [options.cacheThreshold=0.55] - Jaccard similarity threshold
   * @param {boolean} [options.enabled=true]        - AEO on/off
   */
  constructor(options = {}) {
    this.cache         = new SemanticCache({
      maxEntries : options.cacheMaxEntries ?? 512,
      ttlMs      : options.cacheTtlMs,
      threshold  : options.cacheThreshold ?? 0.55
    });
    this.enabled       = options.enabled ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.pipelineLog   = [];

    // Sticky "previous threads" per cache-scope for hysteresis
    this._prevThreads  = new Map();
  }

  // ─── Primary entry point ──────────────────────────────────────────────────

  /**
   * Run a query through the full AEO pipeline and return a decision bundle.
   *
   * @param {string} userQuery     - Raw user query
   * @param {string} sensorContext - Optional verbose sensor data to prune
   * @param {object} deviceState   - { batteryPct, ramUsedPct, cpuTempC }
   * @param {object} options       - { cacheScope }
   * @returns {Promise<object>}    - AEO decision bundle
   */
  async process(userQuery, sensorContext = '', deviceState = {}, options = {}) {
    const t0         = hrNow();
    const cacheScope = options.cacheScope ?? 'default';

    const result = {
      originalQuery : userQuery,
      finalPrompt   : userQuery,
      sensorContext,
      deviceState,

      // Stage outcomes
      stage1 : {
        checked      : false,
        hit          : false,
        elapsedMs    : 0
      },
      stage2 : {
        ran              : false,
        originalTokens   : 0,
        prunedTokens     : 0,
        tags             : [],
        compressionRatio : '0.0',
        sensorValues     : {},
        elapsedMs        : 0,
        error            : null
      },
      stage3 : {
        ran                  : false,
        threads              : 4,
        urgencyLevel         : 'MEDIUM',
        urgencyScore         : 0,
        reason               : '',
        matchedKeywords      : [],
        powerProxyEstimateMs : 0,
        elapsedMs            : 0
      },

      // Final decisions
      threads              : 4,
      cachedResponse       : null,
      cachedMeta           : null,
      powerProxyEstimateMs : 0,
      aeoOverheadMs        : 0,
      errors               : []
    };

    // ── Bypass mode ───────────────────────────────────────────────────────────
    if (!this.enabled) {
      result.threads        = 4;
      result.aeoOverheadMs  = 0;
      return result;
    }

    // ── STAGE 1: SEMANTIC CACHE ───────────────────────────────────────────────
    const t1s = hrNow();
    result.stage1.checked = true;
    const cacheKey    = this._buildCacheKey(userQuery, sensorContext, cacheScope);
    const cacheResult = this.cache.get(cacheKey);
    result.stage1.elapsedMs = hrNow() - t1s;

    if (cacheResult.hit) {
      result.stage1.hit      = true;
      result.cachedResponse  = cacheResult.response;
      result.cachedMeta      = {
        matchedQuery : cacheResult.matchedQuery,
        similarity   : cacheResult.similarity,
        hitCount     : cacheResult.hitCount
      };
      result.aeoOverheadMs = hrNow() - t0;
      this._log('CACHE_HIT', result);
      return result;
    }

    // ── STAGE 2: TOKEN PRUNER ─────────────────────────────────────────────────
    const t2s = hrNow();
    if (sensorContext && sensorContext.trim().length > 50) {
      result.stage2.ran = true;
      try {
        const pruneResult = pruneSensorData(sensorContext, deviceState);
        result.stage2 = {
          ran              : true,
          originalTokens   : pruneResult.originalTokens,
          prunedTokens     : pruneResult.prunedTokens,
          tags             : pruneResult.tags,
          compressionRatio : pruneResult.compressionRatio,
          sensorValues     : pruneResult.sensorValues ?? {},
          elapsedMs        : 0,  // set below
          error            : null
        };
        result.finalPrompt = pruneResult.tags.length > 0
          ? `${userQuery}\n\nDevice context: ${pruneResult.prunedText}`
          : userQuery;
      } catch (err) {
        result.stage2.error = err.message;
        result.errors.push({ stage: 2, message: err.message });
        result.finalPrompt  = userQuery; // graceful fallback
      }
    } else {
      result.finalPrompt          = userQuery;
      const approxTok             = Math.ceil(userQuery.length / 4);
      result.stage2.originalTokens = approxTok;
      result.stage2.prunedTokens   = approxTok;
    }
    result.stage2.elapsedMs = hrNow() - t2s;

    // ── STAGE 3: COMPUTE ALLOCATOR ────────────────────────────────────────────
    const t3s = hrNow();
    result.stage3.ran = true;
    try {
      const prevThreads = this._prevThreads.get(cacheScope);
      const allocResult = allocateThreads(result.finalPrompt, {
        ...deviceState,
        prevThreads
      });
      result.stage3 = {
        ran                  : true,
        threads              : allocResult.threads,
        urgencyLevel         : allocResult.urgencyLevel,
        urgencyScore         : allocResult.urgencyScore ?? 0,
        reason               : allocResult.reason,
        matchedKeywords      : allocResult.matchedKeywords,
        powerProxyEstimateMs : allocResult.powerProxyEstimateMs ?? 0,
        elapsedMs            : 0, // set below
        error                : null
      };
      result.threads               = allocResult.threads;
      result.powerProxyEstimateMs  = allocResult.powerProxyEstimateMs ?? 0;
      this._prevThreads.set(cacheScope, allocResult.threads);
    } catch (err) {
      result.stage3.error = err.message;
      result.errors.push({ stage: 3, message: err.message });
      // safe default
      result.threads = 4;
    }
    result.stage3.elapsedMs = hrNow() - t3s;

    result.aeoOverheadMs = hrNow() - t0;
    this._log('PIPELINE_COMPLETE', result);
    return result;
  }

  // ─── Cache management ─────────────────────────────────────────────────────

  /**
   * Store a completed inference result in the semantic cache.
   */
  cacheResponse(query, response, sensorContext = '', cacheScope = 'default') {
    const key = this._buildCacheKey(query, sensorContext, cacheScope);
    this.cache.set(key, response);
  }

  /**
   * Pre-populate the cache with known query→response pairs.
   * Call before benchmarking to eliminate cold-start penalty.
   *
   * @param {Array<{ query: string, response: *, sensorContext?: string, scope?: string }>} corpus
   */
  warmUp(corpus) {
    for (const item of corpus) {
      this.cacheResponse(
        item.query,
        item.response,
        item.sensorContext ?? '',
        item.scope ?? 'default'
      );
    }
  }

  clearCacheScope(cacheScope) {
    this._prevThreads.delete(cacheScope);
    return this.cache.clearScope(cacheScope);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  purgeExpiredCacheEntries() {
    return this.cache.purgeExpired();
  }

  // ─── Logging & audit ──────────────────────────────────────────────────────

  _log(event, result) {
    const entry = {
      timestamp        : new Date().toISOString(),
      event,
      query            : result.originalQuery.substring(0, 80),
      cacheHit         : result.stage1.hit,
      threads          : result.threads,
      urgency          : result.stage3.urgencyLevel,
      urgencyScore     : result.stage3.urgencyScore,
      compressionRatio : result.stage2.compressionRatio,
      overheadMs       : parseFloat(result.aeoOverheadMs.toFixed(3)),
      stage1Ms         : parseFloat(result.stage1.elapsedMs.toFixed(3)),
      stage2Ms         : parseFloat(result.stage2.elapsedMs.toFixed(3)),
      stage3Ms         : parseFloat(result.stage3.elapsedMs.toFixed(3)),
      powerProxyMs     : result.powerProxyEstimateMs,
      errors           : result.errors.length > 0 ? result.errors : undefined
    };
    this.pipelineLog.push(entry);
    if (this.pipelineLog.length > this.maxLogEntries) {
      this.pipelineLog.shift();
    }
  }

  getPipelineLog() {
    return this.pipelineLog;
  }

  /**
   * Export the pipeline log as a CSV string (for direct LaTeX / Python use).
   */
  exportLogAsCSV() {
    if (this.pipelineLog.length === 0) return '';
    const headers = Object.keys(this.pipelineLog[0]).join(',');
    const rows    = this.pipelineLog.map(entry =>
      Object.values(entry)
        .map(v => (typeof v === 'object' ? JSON.stringify(v) : v) ?? '')
        .join(',')
    );
    return [headers, ...rows].join('\n');
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  _buildCacheKey(query, sensorContext = '', cacheScope = 'default') {
    const contextPart = sensorContext && sensorContext.trim().length > 0
      ? ` [context: ${sensorContext.substring(0, 160)}]`
      : '';
    return `[scope:${cacheScope}] ${query}${contextPart}`;
  }
}