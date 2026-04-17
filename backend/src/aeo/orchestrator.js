/**
 * AEO Orchestrator — Main Middleware Entry Point
 *
 * Chains Stage 1 → Stage 2 → Stage 3 before dispatching
 * to the llama.cpp inference engine.
 *
 * This is the "pre-layer" that sits between user input and inference.
 */

import { SemanticCache } from './semanticCache.js';
import { pruneSensorData } from './tokenPruner.js';
import { allocateThreads } from './computeAllocator.js';

export class AEOOrchestrator {
  constructor() {
    this.cache = new SemanticCache();
    this.enabled = true;
    this.pipelineLog = []; // audit trail for each run
  }

  /**
   * Run a query through the full AEO pipeline.
   *
   * @param {string} userQuery - Raw user query
   * @param {string} sensorContext - Optional verbose sensor data to prune
   * @param {object} deviceState - { batteryPct, ramUsedPct }
   * @returns {object} AEO decision bundle consumed by the inference engine
   */
  async process(userQuery, sensorContext = '', deviceState = {}) {
    const startTime = process.hrtime.bigint();

    const result = {
      originalQuery: userQuery,
      finalPrompt: userQuery,
      sensorContext,
      deviceState,
      // Stage outcomes
      stage1: { checked: false, hit: false },
      stage2: { ran: false, originalTokens: 0, prunedTokens: 0, tags: [], compressionRatio: '0.0' },
      stage3: { ran: false, threads: 4, urgencyLevel: 'MEDIUM', reason: '', matchedKeywords: [] },
      // Final decision
      threads: 4,
      cachedResponse: null,
      aeoOverheadMs: 0
    };

    if (!this.enabled) {
      // Bypass: behave as baseline
      result.threads = 4;
      result.stage3.ran = false;
      result.aeoOverheadMs = 0;
      return result;
    }

    // ── STAGE 1: SEMANTIC CACHE ──────────────────────────────────────────────
    result.stage1.checked = true;
    const fullQuery = sensorContext
      ? `${userQuery} [context: ${sensorContext.substring(0, 80)}]`
      : userQuery;

    const cacheResult = this.cache.get(userQuery);
    if (cacheResult.hit) {
      result.stage1.hit = true;
      result.cachedResponse = cacheResult.response;
      result.cachedMeta = {
        matchedQuery: cacheResult.matchedQuery,
        similarity: cacheResult.similarity,
        hitCount: cacheResult.hitCount
      };
      const overhead = Number(process.hrtime.bigint() - startTime) / 1e6;
      result.aeoOverheadMs = overhead;
      this._log('CACHE_HIT', result);
      return result;
    }

    // ── STAGE 2: TOKEN PRUNER ────────────────────────────────────────────────
    if (sensorContext && sensorContext.trim().length > 50) {
      result.stage2.ran = true;
      const pruneResult = pruneSensorData(sensorContext, deviceState);
      result.stage2 = { ran: true, ...pruneResult };

      // Build compressed prompt: query + semantic tags
      result.finalPrompt = pruneResult.tags.length > 0
        ? `${userQuery}\n\nDevice context: ${pruneResult.prunedText}`
        : userQuery;
    } else {
      // No sensor context — still build final prompt cleanly
      result.finalPrompt = userQuery;
      result.stage2.originalTokens = Math.ceil(userQuery.split(/\s+/).length * 1.3);
      result.stage2.prunedTokens = result.stage2.originalTokens;
    }

    // ── STAGE 3: COMPUTE ALLOCATOR ───────────────────────────────────────────
    result.stage3.ran = true;
    const allocResult = allocateThreads(result.finalPrompt, deviceState);
    result.stage3 = { ran: true, ...allocResult };
    result.threads = allocResult.threads;

    const overhead = Number(process.hrtime.bigint() - startTime) / 1e6;
    result.aeoOverheadMs = overhead;

    this._log('PIPELINE_COMPLETE', result);
    return result;
  }

  /**
   * Store a completed inference result into the semantic cache
   */
  cacheResponse(query, response) {
    this.cache.set(query, response);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  _log(event, result) {
    this.pipelineLog.push({
      timestamp: new Date().toISOString(),
      event,
      query: result.originalQuery.substring(0, 80),
      cacheHit: result.stage1.hit,
      threads: result.threads,
      urgency: result.stage3.urgencyLevel,
      compressionRatio: result.stage2.compressionRatio,
      overheadMs: result.aeoOverheadMs
    });
    // Keep log bounded
    if (this.pipelineLog.length > 500) this.pipelineLog.shift();
  }

  getPipelineLog() {
    return this.pipelineLog;
  }
}
