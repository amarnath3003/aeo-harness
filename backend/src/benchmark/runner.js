/**
 * Benchmark Runner
 *
 * Executes the full predefined test corpus through BOTH pipelines:
 *   - Baseline: static 4 threads, raw context, no caching
 *   - AEO: full Stage 1→2→3 middleware
 *
 * Outputs metrics to JSON + CSV for analysis.
 *
 * Test categories per the research paper spec:
 *   A: High-Urgency (SOS/medical) — triggers MAX threads in AEO
 *   B: Low-Urgency (basic skills) — triggers MIN threads in AEO
 *   C: Pruner Test (200-word sensor dump) — AEO compresses, Baseline processes raw
 *   D: Cache Test (repeated query) — AEO hit on 2nd run, Baseline reruns fully
 */

import { generateVerboseSensorData } from '../aeo/tokenPruner.js';
import si from 'systeminformation';
import { EventEmitter } from 'events';

export const TEST_CORPUS = [
  // ── CATEGORY A: HIGH URGENCY ────────────────────────────────────────────────
  {
    id: 'A1',
    category: 'A',
    categoryLabel: 'High-Urgency',
    query: 'SOS! I have a deep puncture wound in my thigh and it is bleeding heavily.',
    sensorContext: '',
    expectedAeoThreads: 8,
    description: 'Critical injury — should trigger MAX_THREADS (8) in AEO'
  },
  {
    id: 'A2',
    category: 'A',
    categoryLabel: 'High-Urgency',
    query: 'My companion is unconscious and not breathing after a fall. What do I do?',
    sensorContext: '',
    expectedAeoThreads: 8,
    description: 'Life-threatening — should trigger MAX_THREADS'
  },

  // ── CATEGORY B: LOW URGENCY ─────────────────────────────────────────────────
  {
    id: 'B1',
    category: 'B',
    categoryLabel: 'Low-Urgency',
    query: 'How do I tie a basic square knot?',
    sensorContext: '',
    expectedAeoThreads: 2,
    description: 'Non-urgent skill — should trigger MIN_THREADS (1-2) in AEO'
  },
  {
    id: 'B2',
    category: 'B',
    categoryLabel: 'Low-Urgency',
    query: 'What is the general technique for starting a fire with a bow drill?',
    sensorContext: '',
    expectedAeoThreads: 2,
    description: 'General knowledge query — should use reduced threads'
  },

  // ── CATEGORY C: TOKEN PRUNER ─────────────────────────────────────────────────
  {
    id: 'C1',
    category: 'C',
    categoryLabel: 'Pruner-Test',
    query: 'Based on the current conditions, should I set up camp now or push on?',
    sensorContext: '__GENERATE__', // replaced at runtime with 200-word dump
    expectedAeoThreads: 4,
    description: 'AEO prunes 200-word sensor dump to semantic tags'
  },
  {
    id: 'C2',
    category: 'C',
    categoryLabel: 'Pruner-Test',
    query: 'What is the storm risk at my current location?',
    sensorContext: '__GENERATE__',
    expectedAeoThreads: 4,
    description: 'Weather assessment with verbose GPS/baro data'
  },

  // ── CATEGORY D: CACHE TEST ──────────────────────────────────────────────────
  {
    id: 'D1',
    category: 'D',
    categoryLabel: 'Cache-Test-Run1',
    query: 'How do I start a fire in wet conditions?',
    sensorContext: '',
    expectedAeoThreads: 4,
    description: 'First run — populates cache, no hit expected'
  },
  {
    id: 'D2',
    category: 'D',
    categoryLabel: 'Cache-Test-Run2',
    query: 'How do I start a fire in wet conditions?', // exact repeat → guaranteed cache hit
    sensorContext: '',
    expectedAeoThreads: 0, // 0 = served from cache (0 compute threads)
    description: 'Second run — should return instantly from cache (0 compute)'
  },
  {
    id: 'D3',
    category: 'D',
    categoryLabel: 'Cache-Test-Semantic',
    query: 'What is the best method to ignite a fire when the wood is wet?', // semantic match
    sensorContext: '',
    expectedAeoThreads: 0,
    description: 'Semantic variant — should still hit cache via Jaccard similarity'
  }
];

export class BenchmarkRunner extends EventEmitter {
  constructor(llamaEngine, aeoOrchestrator) {
    super();
    this.engine = llamaEngine;
    this.aeo = aeoOrchestrator;
    this.results = [];
    this.isRunning = false;
  }

  /**
   * Run a single test case through a specified pipeline.
   * @param {object} testCase
   * @param {'Baseline'|'AEO'} pipeline
   * @param {object} deviceState - { batteryPct, ramUsedPct }
   */
  async runSingle(testCase, pipeline, deviceState = { batteryPct: 75, ramUsedPct: 0.4 }) {
    const tc = { ...testCase };

    // Resolve sensor context
    if (tc.sensorContext === '__GENERATE__') {
      tc.sensorContext = generateVerboseSensorData({
        altitude: 3200 + Math.random() * 1200,
        pressure: 610 + Math.random() * 50,
        trend: -(3 + Math.random() * 8),
        temp: -4 + Math.random() * 15 - 8,
        wind: 30 + Math.random() * 30,
        battery: deviceState.batteryPct
      });
    }

    const runMeta = {
      test_id: tc.id,
      category: tc.category,
      category_label: tc.categoryLabel,
      pipeline_used: pipeline,
      query: tc.query,
      device_battery_pct: deviceState.batteryPct,
      device_ram_pct: (deviceState.ramUsedPct * 100).toFixed(1),
      timestamp: new Date().toISOString()
    };

    let inferResult;
    let aeoDecision = null;
    let pruneMeta = null;

    // Sample memory before
    const memBefore = await this._sampleMemory();

    if (pipeline === 'AEO') {
      // Run through full AEO middleware
      aeoDecision = await this.aeo.process(
        tc.query,
        tc.sensorContext,
        deviceState,
        { cacheScope: 'benchmark' }
      );

      // Cache hit — zero compute
      if (aeoDecision.cachedResponse) {
        const result = {
          ...runMeta,
          thread_count: 0,
          prompt_eval_time_sec: 0,
          time_to_first_token_sec: 0.001, // near-instant
          generation_rate_tps: Infinity,
          total_generation_time_sec: 0.001,
          power_proxy_core_seconds: 0,
          cache_hit: true,
          tokens_original: aeoDecision.stage2.originalTokens || 0,
          tokens_pruned: aeoDecision.stage2.prunedTokens || 0,
          compression_ratio_pct: aeoDecision.stage2.compressionRatio || '0.0',
          urgency_level: 'CACHED',
          aeo_reason: 'Stage 1 cache hit — zero compute',
          aeo_overhead_ms: aeoDecision.aeoOverheadMs,
          response_preview: aeoDecision.cachedResponse.substring(0, 100),
          ram_before_mb: memBefore.usedMb,
          ram_after_mb: memBefore.usedMb,
          ram_delta_mb: 0,
          is_mock: !this.engine.isLoaded
        };
        this.results.push(result);
        this.emit('result', result);
        return result;
      }

      pruneMeta = aeoDecision.stage2;
      const threads = aeoDecision.threads;
      const finalPrompt = aeoDecision.finalPrompt;

      inferResult = await this.engine.infer(finalPrompt, threads, {
        maxTokens: 300,
        onToken: (tok) => this.emit('token', { pipeline: 'AEO', token: tok })
      });

      // Cache the result for future hits
      this.aeo.cacheResponse(tc.query, inferResult.response, tc.sensorContext, 'benchmark');

      const memAfter = await this._sampleMemory();

      const result = {
        ...runMeta,
        thread_count: threads,
        prompt_eval_time_sec: inferResult.metrics.prompt_eval_time_sec,
        time_to_first_token_sec: inferResult.metrics.time_to_first_token_sec,
        generation_rate_tps: parseFloat(inferResult.metrics.generation_rate_tps.toFixed(2)),
        total_generation_time_sec: inferResult.metrics.total_generation_time_sec,
        power_proxy_core_seconds: parseFloat(inferResult.metrics.power_proxy_core_seconds.toFixed(4)),
        cache_hit: false,
        tokens_original: pruneMeta.originalTokens || Math.ceil(tc.query.split(' ').length * 1.3),
        tokens_pruned: pruneMeta.prunedTokens || Math.ceil(tc.query.split(' ').length * 1.3),
        compression_ratio_pct: pruneMeta.compressionRatio || '0.0',
        aeo_tags: (pruneMeta.tags || []).join(' '),
        urgency_level: aeoDecision.stage3.urgencyLevel,
        aeo_reason: aeoDecision.stage3.reason,
        aeo_overhead_ms: parseFloat(aeoDecision.aeoOverheadMs.toFixed(2)),
        response_preview: inferResult.response.substring(0, 100),
        ram_before_mb: memBefore.usedMb,
        ram_after_mb: memAfter.usedMb,
        ram_delta_mb: parseFloat((memAfter.usedMb - memBefore.usedMb).toFixed(1)),
        is_mock: inferResult.isMock || false
      };
      this.results.push(result);
      this.emit('result', result);
      return result;

    } else {
      // BASELINE pipeline — raw, static 4 threads, no AEO
      const BASELINE_THREADS = 4;
      const rawPrompt = tc.sensorContext
        ? `${tc.query}\n\nSensor data: ${tc.sensorContext}`
        : tc.query;
      const rawTokens = Math.ceil(rawPrompt.split(/\s+/).length * 1.3);

      inferResult = await this.engine.infer(rawPrompt, BASELINE_THREADS, {
        maxTokens: 300,
        onToken: (tok) => this.emit('token', { pipeline: 'Baseline', token: tok })
      });

      const memAfter = await this._sampleMemory();

      const result = {
        ...runMeta,
        thread_count: BASELINE_THREADS,
        prompt_eval_time_sec: inferResult.metrics.prompt_eval_time_sec,
        time_to_first_token_sec: inferResult.metrics.time_to_first_token_sec,
        generation_rate_tps: parseFloat(inferResult.metrics.generation_rate_tps.toFixed(2)),
        total_generation_time_sec: inferResult.metrics.total_generation_time_sec,
        power_proxy_core_seconds: parseFloat(inferResult.metrics.power_proxy_core_seconds.toFixed(4)),
        cache_hit: false,
        tokens_original: rawTokens,
        tokens_pruned: rawTokens,
        compression_ratio_pct: '0.0',
        aeo_tags: '',
        urgency_level: 'N/A',
        aeo_reason: 'Baseline — no AEO',
        aeo_overhead_ms: 0,
        response_preview: inferResult.response.substring(0, 100),
        ram_before_mb: memBefore.usedMb,
        ram_after_mb: memAfter.usedMb,
        ram_delta_mb: parseFloat((memAfter.usedMb - memBefore.usedMb).toFixed(1)),
        is_mock: inferResult.isMock || false
      };
      this.results.push(result);
      this.emit('result', result);
      return result;
    }
  }

  /**
   * Run the full benchmark: each test case through BOTH pipelines.
   * Order: Baseline first, then AEO (cache starts cold).
   */
  async runFull(onProgress = null) {
    if (this.isRunning) throw new Error('Benchmark already running');
    this.isRunning = true;
    this.results = [];
    this.aeo.clearCacheScope('benchmark'); // always start benchmark with cold benchmark cache

    const totalRuns = TEST_CORPUS.length * 2;
    let completed = 0;

    // Simulate realistic device state that drifts over time
    let deviceState = { batteryPct: 78, ramUsedPct: 0.38 };

    this.emit('start', { total: totalRuns });

    for (const tc of TEST_CORPUS) {
      // Baseline first
      this.emit('progress', { completed, total: totalRuns, pipeline: 'Baseline', testId: tc.id });
      try {
        await this.runSingle(tc, 'Baseline', { ...deviceState });
      } catch(e) {
        console.error(`Baseline ${tc.id} failed:`, e.message);
      }
      completed++;

      // Drift device state (battery drains, RAM fluctuates)
      deviceState.batteryPct = Math.max(15, deviceState.batteryPct - (1 + Math.random() * 2));
      deviceState.ramUsedPct = Math.min(0.92, Math.max(0.2, deviceState.ramUsedPct + (Math.random() - 0.4) * 0.08));

      // Small delay between runs to let CPU cool
      await new Promise(r => setTimeout(r, 200));

      // AEO pipeline
      this.emit('progress', { completed, total: totalRuns, pipeline: 'AEO', testId: tc.id });
      try {
        await this.runSingle(tc, 'AEO', { ...deviceState });
      } catch(e) {
        console.error(`AEO ${tc.id} failed:`, e.message);
      }
      completed++;

      deviceState.batteryPct = Math.max(15, deviceState.batteryPct - (0.5 + Math.random()));
      deviceState.ramUsedPct = Math.min(0.92, Math.max(0.2, deviceState.ramUsedPct + (Math.random() - 0.5) * 0.05));

      if (onProgress) onProgress({ completed, total: totalRuns });
      await new Promise(r => setTimeout(r, 300));
    }

    this.isRunning = false;
    this.emit('complete', { results: this.results });
    return this.results;
  }

  async _sampleMemory() {
    try {
      const mem = await si.mem();
      return { usedMb: parseFloat((mem.used / 1024 / 1024).toFixed(1)) };
    } catch {
      return { usedMb: 0 };
    }
  }

  getResults() { return this.results; }

  exportJSON() {
    return JSON.stringify(this.results, null, 2);
  }

  exportCSV() {
    if (this.results.length === 0) return '';
    const headers = Object.keys(this.results[0]);
    const rows = this.results.map(r =>
      headers.map(h => {
        const v = r[h];
        return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
      }).join(',')
    );
    return [headers.join(','), ...rows].join('\n');
  }
}
