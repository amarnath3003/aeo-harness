/**
 * AEO Orchestrator  (v3) — Main Middleware Entry Point
 *
 * ── What changed from v2 ─────────────────────────────────────────────────────
 *
 * 1. inferenceParams pass-through
 *    Stage 3 now produces a full `inferenceParams` bundle (flashAttention,
 *    kvCacheTypek/v, batchSize, ubatchSize).  The orchestrator surfaces this
 *    at the top level of the result object so the inference engine caller
 *    can map it directly to node-llama-cpp context options without any
 *    further translation.
 *
 *    Usage in your inference wrapper:
 *      const aeo = await orchestrator.process(query, sensorCtx, deviceState);
 *      const ctx = await model.createContext({
 *        threads         : aeo.threads,
 *        flashAttention  : aeo.inferenceParams.flashAttention,
 *        batchSize       : aeo.inferenceParams.batchSize,
 *        // KV cache type is a CLI-level flag; pass aeo.inferenceParams.kvCacheTypek
 *        // to your llama.cpp spawn args if using the CLI path.
 *      });
 *
 * 2. Prompt-length TTFT heuristic
 *    The orchestrator estimates `ttftEstimateMs` (time-to-first-token) from
 *    the pruned prompt token count × a per-thread prompt_eval coefficient.
 *    This gives the benchmark runner a pre-inference TTFT prediction to
 *    compare against the actual measured value — useful for the paper's
 *    model-accuracy section.
 *
 * 3. deviceProfile forwarded to Stage 3
 *    If the caller sets deviceState.deviceProfile (e.g. 'SD8G2'), the
 *    orchestrator passes it through to allocateThreads so the correct
 *    perfCores value is used.  No change needed at call sites that don't
 *    know their SoC — 'GENERIC' (4 perf-cores) remains the safe default.
 *
 * 4. inferenceParams logged per entry
 *    The pipeline log now records the active preset name (_preset field)
 *    so the CSV export shows which KV quantisation tier was active per run.
 */

import { SemanticCache }   from './semanticCache.js';
import { pruneSensorData } from './tokenPruner.js';
import { allocateThreads } from './computeAllocator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hrNow() {
  if (typeof process !== 'undefined' && process.hrtime) {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return performance.now();
}

// Per-thread prompt_eval throughput coefficients (tokens/sec).
// Used to estimate TTFT from pruned prompt length.
// Measured on Gemma-3-1B Q4_K_M with flash attention enabled.
const PROMPT_EVAL_TPS = { 1: 180, 2: 320, 4: 580, 6: 720, 8: 780 };

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class AEOOrchestrator {
  /**
   * @param {object} options
   * @param {number}  [options.maxLogEntries=500]
   * @param {number}  [options.cacheMaxEntries=512]
   * @param {number}  [options.cacheTtlMs]
   * @param {number}  [options.cacheThreshold=0.55]
   * @param {boolean} [options.enabled=true]
   */
  constructor(options = {}) {
    this.cache = new SemanticCache({
      maxEntries : options.cacheMaxEntries ?? 512,
      ttlMs      : options.cacheTtlMs,
      threshold  : options.cacheThreshold ?? 0.55
    });
    this.enabled       = options.enabled ?? true;
    this.maxLogEntries = options.maxLogEntries ?? 500;
    this.pipelineLog   = [];
    this._prevThreads  = new Map();
  }

  // ─── Primary entry point ──────────────────────────────────────────────────

  /**
   * Run a query through the full AEO pipeline.
   *
   * @param {string} userQuery
   * @param {string} sensorContext
   * @param {object} deviceState  — { batteryPct, ramUsedPct, cpuTempC, deviceProfile }
   * @param {object} options      — { cacheScope }
   * @returns {Promise<object>}
   */
  async process(userQuery, sensorContext = '', deviceState = {}, options = {}) {
    const t0         = hrNow();
    const cacheScope = options.cacheScope ?? 'default';

    const result = {
      originalQuery : userQuery,
      finalPrompt   : userQuery,
      sensorContext,
      deviceState,

      stage1 : { checked: false, hit: false, elapsedMs: 0 },
      stage2 : {
        ran: false, originalTokens: 0, prunedTokens: 0,
        tags: [], compressionRatio: '0.0', sensorValues: {},
        elapsedMs: 0, error: null
      },
      stage3 : {
        ran: false, threads: 4, urgencyLevel: 'MEDIUM', urgencyScore: 0,
        reason: '', matchedKeywords: [], inferenceParams: {},
        powerProxyEstimateMs: 0, elapsedMs: 0
      },

      // ── Top-level fields consumed by the inference engine ──────────────────
      threads              : 4,
      inferenceParams      : {        // safe defaults if Stage 3 skipped
        flashAttention : true,
        kvCacheTypek   : 'q8_0',
        kvCacheTypev   : 'q8_0',
        batchSize      : 512,
        ubatchSize     : 256,
        _preset        : 'BALANCED'
      },
      ttftEstimateMs       : 0,       // pre-inference TTFT prediction
      cachedResponse       : null,
      cachedMeta           : null,
      powerProxyEstimateMs : 0,
      aeoOverheadMs        : 0,
      errors               : []
    };

    // ── Bypass mode ───────────────────────────────────────────────────────────
    if (!this.enabled) {
      result.threads       = 4;
      result.aeoOverheadMs = 0;
      return result;
    }

    // ── STAGE 1: SEMANTIC CACHE ───────────────────────────────────────────────
    const t1s = hrNow();
    result.stage1.checked = true;
    const cacheKey    = this._buildCacheKey(userQuery, sensorContext, cacheScope);
    const cacheResult = this.cache.get(cacheKey);
    result.stage1.elapsedMs = hrNow() - t1s;

    if (cacheResult.hit) {
      result.stage1.hit     = true;
      result.cachedResponse = cacheResult.response;
      result.cachedMeta     = {
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
        const pr = pruneSensorData(sensorContext, deviceState);
        result.stage2 = {
          ran              : true,
          originalTokens   : pr.originalTokens,
          prunedTokens     : pr.prunedTokens,
          tags             : pr.tags,
          compressionRatio : pr.compressionRatio,
          sensorValues     : pr.sensorValues ?? {},
          elapsedMs        : 0,
          error            : null
        };
        result.finalPrompt = pr.tags.length > 0
          ? `${userQuery}\n\nDevice context: ${pr.prunedText}`
          : userQuery;
      } catch (err) {
        result.stage2.error = err.message;
        result.errors.push({ stage: 2, message: err.message });
        result.finalPrompt  = userQuery;
      }
    } else {
      const approxTok = Math.ceil(userQuery.length / 4);
      result.stage2.originalTokens = approxTok;
      result.stage2.prunedTokens   = approxTok;
      result.finalPrompt           = userQuery;
    }
    result.stage2.elapsedMs = hrNow() - t2s;

    // ── STAGE 3: COMPUTE ALLOCATOR ────────────────────────────────────────────
    const t3s = hrNow();
    result.stage3.ran = true;
    try {
      const prevThreads = this._prevThreads.get(cacheScope);
      const ar = allocateThreads(result.finalPrompt, { ...deviceState, prevThreads });

      result.stage3 = {
        ran                  : true,
        threads              : ar.threads,
        urgencyLevel         : ar.urgencyLevel,
        urgencyScore         : ar.urgencyScore ?? 0,
        reason               : ar.reason,
        matchedKeywords      : ar.matchedKeywords,
        inferenceParams      : ar.inferenceParams,
        powerProxyEstimateMs : ar.powerProxyEstimateMs ?? 0,
        elapsedMs            : 0,
        error                : null
      };

      result.threads              = ar.threads;
      result.inferenceParams      = ar.inferenceParams;
      result.powerProxyEstimateMs = ar.powerProxyEstimateMs ?? 0;
      this._prevThreads.set(cacheScope, ar.threads);

      // TTFT estimate: pruned prompt tokens ÷ prompt_eval throughput
      const promptToks      = result.stage2.prunedTokens || Math.ceil(result.finalPrompt.length / 4);
      const evalTps         = PROMPT_EVAL_TPS[ar.threads] ?? PROMPT_EVAL_TPS[4];
      result.ttftEstimateMs = Math.round((promptToks / evalTps) * 1000);

    } catch (err) {
      result.stage3.error = err.message;
      result.errors.push({ stage: 3, message: err.message });
      result.threads = 4;
    }
    result.stage3.elapsedMs = hrNow() - t3s;

    result.aeoOverheadMs = hrNow() - t0;
    this._log('PIPELINE_COMPLETE', result);
    return result;
  }

  // ─── Cache management ─────────────────────────────────────────────────────

  cacheResponse(query, response, sensorContext = '', cacheScope = 'default') {
    this.cache.set(this._buildCacheKey(query, sensorContext, cacheScope), response);
  }

  /**
   * Pre-populate the cache before benchmarking to eliminate cold-start penalty.
   * @param {Array<{ query, response, sensorContext?, scope? }>} corpus
   */
  warmUp(corpus) {
    for (const item of corpus) {
      this.cacheResponse(
        item.query, item.response,
        item.sensorContext ?? '', item.scope ?? 'default'
      );
    }
  }

  clearCacheScope(scope) {
    this._prevThreads.delete(scope);
    return this.cache.clearScope(scope);
  }

  getCacheStats()         { return this.cache.getStats();     }
  purgeExpiredCacheEntries() { return this.cache.purgeExpired(); }

  // ─── Logging ──────────────────────────────────────────────────────────────

  _log(event, result) {
    this.pipelineLog.push({
      timestamp        : new Date().toISOString(),
      event,
      query            : result.originalQuery.substring(0, 80),
      cacheHit         : result.stage1.hit,
      threads          : result.threads,
      urgency          : result.stage3.urgencyLevel,
      urgencyScore     : result.stage3.urgencyScore,
      kvPreset         : result.inferenceParams?._preset ?? 'n/a',
      flashAttention   : result.inferenceParams?.flashAttention ?? false,
      compressionRatio : result.stage2.compressionRatio,
      overheadMs       : parseFloat(result.aeoOverheadMs.toFixed(3)),
      stage1Ms         : parseFloat(result.stage1.elapsedMs.toFixed(3)),
      stage2Ms         : parseFloat(result.stage2.elapsedMs.toFixed(3)),
      stage3Ms         : parseFloat(result.stage3.elapsedMs.toFixed(3)),
      ttftEstimateMs   : result.ttftEstimateMs,
      powerProxyMs     : result.powerProxyEstimateMs,
      errors           : result.errors.length > 0 ? result.errors : undefined
    });
    if (this.pipelineLog.length > this.maxLogEntries) this.pipelineLog.shift();
  }

  getPipelineLog() { return this.pipelineLog; }

  /**
   * Export pipeline log as CSV for direct use in LaTeX tables or pandas.
   * Escapes commas inside string fields.
   */
  exportLogAsCSV() {
    if (this.pipelineLog.length === 0) return '';
    const escape = v => {
      if (v === undefined || v === null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = Object.keys(this.pipelineLog[0]).join(',');
    const rows    = this.pipelineLog.map(e => Object.values(e).map(escape).join(','));
    return [headers, ...rows].join('\n');
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _buildCacheKey(query, sensorContext = '', cacheScope = 'default') {
    const ctx = sensorContext?.trim().length > 0
      ? ` [context: ${sensorContext.substring(0, 160)}]`
      : '';
    return `[scope:${cacheScope}] ${query}${ctx}`;
  }
}