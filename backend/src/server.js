/**
 * AEO Research Harness — Express Server
 *
 * Endpoints:
 *   GET  /api/status          — engine + model status
 *   POST /api/infer           — single inference (interactive chat)
 *   POST /api/benchmark/start — run full automated benchmark
 *   GET  /api/benchmark/stream— SSE stream of benchmark progress/results
 *   GET  /api/benchmark/results — get completed results JSON
 *   GET  /api/benchmark/export/csv — download CSV
 *   GET  /api/telemetry       — current telemetry sample
 *   GET  /api/telemetry/stream— SSE stream of live telemetry
 *   GET  /api/aeo/cache       — cache statistics
 *   GET  /api/aeo/log         — AEO pipeline audit log
 */

import './env.js'; // must be first — loads .env into process.env
import express from 'express';
import cors from 'cors';
import { LlamaEngine } from './llamaEngine.js';
import { AEOOrchestrator } from './aeo/orchestrator.js';
import { BenchmarkRunner, TEST_CORPUS } from './benchmark/runner.js';
import { TelemetrySampler } from './utils/telemetry.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Global singletons ────────────────────────────────────────────────────────
const engine      = new LlamaEngine();
const aeo         = new AEOOrchestrator();
const telemetry   = new TelemetrySampler();
let benchmarkRunner = null;

// SSE client registries
const benchmarkClients = new Set();
const telemetryClients = new Set();

// ── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== AEO Research Harness Backend ===');
  await engine.load();
  telemetry.start(500);
  telemetry.on('sample', (s) => {
    const data = JSON.stringify(s);
    for (const res of telemetryClients) {
      res.write(`data: ${data}\n\n`);
    }
  });
  console.log(`Server ready. Model loaded: ${engine.isLoaded}`);
})();

// ── SSE helper ───────────────────────────────────────────────────────────────
function initSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Heartbeat every 15s
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(hb));
  return hb;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    modelLoaded: engine.isLoaded,
    modelPath: engine.modelPath,
    isMock: !engine.isLoaded,
    aeoEnabled: aeo.enabled,
    cacheStats: aeo.getCacheStats(),
    telemetrySamples: telemetry.getSamples().length,
    uptime: process.uptime().toFixed(0)
  });
});

// Interactive chat endpoint — routes through AEO or directly
app.post('/api/infer', async (req, res) => {
  const {
    query,
    sensorContext = '',
    deviceState = { batteryPct: 75, ramUsedPct: 0.4 },
    useAEO = true,
    stream = false
  } = req.body;

  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    let threads = 4;
    let aeoDecision = null;

    if (useAEO) {
      aeoDecision = await aeo.process(query, sensorContext, deviceState);

      if (aeoDecision.cachedResponse) {
        return res.json({
          response: aeoDecision.cachedResponse,
          pipeline: 'AEO',
          cached: true,
          aeoDecision,
          metrics: {
            prompt_eval_time_sec: 0,
            time_to_first_token_sec: 0.001,
            generation_rate_tps: 9999,
            total_generation_time_sec: 0.001,
            power_proxy_core_seconds: 0
          }
        });
      }
      threads = aeoDecision.threads;
    }

    telemetry.notifyRunStart(useAEO ? 'AEO' : 'Baseline', threads);

    if (stream) {
      // SSE streaming for live token display
      initSSE(req, res);
      let fullResponse = '';

      const result = await engine.infer(
        useAEO ? aeoDecision.finalPrompt : query,
        threads,
        {
          maxTokens: 400,
          onToken: (tok) => {
            fullResponse += tok;
            res.write(`data: ${JSON.stringify({ token: tok })}\n\n`);
          }
        }
      );

      if (useAEO) aeo.cacheResponse(query, result.response);
      telemetry.notifyRunEnd(useAEO ? 'AEO' : 'Baseline');

      res.write(`data: ${JSON.stringify({
        done: true,
        metrics: result.metrics,
        aeoDecision,
        pipeline: useAEO ? 'AEO' : 'Baseline',
        threads
      })}\n\n`);
      res.end();

    } else {
      const result = await engine.infer(
        useAEO ? aeoDecision?.finalPrompt : query,
        threads,
        { maxTokens: 400 }
      );

      if (useAEO) aeo.cacheResponse(query, result.response);
      telemetry.notifyRunEnd(useAEO ? 'AEO' : 'Baseline');

      res.json({
        response: result.response,
        pipeline: useAEO ? 'AEO' : 'Baseline',
        cached: false,
        threads,
        aeoDecision,
        metrics: result.metrics,
        isMock: result.isMock
      });
    }

  } catch (err) {
    console.error('/api/infer error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start benchmark run
app.post('/api/benchmark/start', async (req, res) => {
  if (benchmarkRunner?.isRunning) {
    return res.status(409).json({ error: 'Benchmark already running' });
  }

  benchmarkRunner = new BenchmarkRunner(engine, aeo);

  // Wire events → SSE clients
  benchmarkRunner.on('start', (d) => {
    const payload = JSON.stringify({ event: 'start', ...d });
    benchmarkClients.forEach(c => c.write(`data: ${payload}\n\n`));
  });

  benchmarkRunner.on('progress', (d) => {
    const payload = JSON.stringify({ event: 'progress', ...d });
    benchmarkClients.forEach(c => c.write(`data: ${payload}\n\n`));
    telemetry.notifyRunStart(d.pipeline, 4);
  });

  benchmarkRunner.on('result', (d) => {
    const payload = JSON.stringify({ event: 'result', result: d });
    benchmarkClients.forEach(c => c.write(`data: ${payload}\n\n`));
    telemetry.notifyRunEnd(d.pipeline_used);
  });

  benchmarkRunner.on('complete', (d) => {
    const payload = JSON.stringify({ event: 'complete', count: d.results.length });
    benchmarkClients.forEach(c => c.write(`data: ${payload}\n\n`));
  });

  res.json({ started: true, tests: TEST_CORPUS.length, message: 'Stream /api/benchmark/stream for live events' });

  // Run async
  benchmarkRunner.runFull().catch(err => {
    console.error('Benchmark error:', err);
    const payload = JSON.stringify({ event: 'error', message: err.message });
    benchmarkClients.forEach(c => c.write(`data: ${payload}\n\n`));
  });
});

// SSE stream — benchmark events
app.get('/api/benchmark/stream', (req, res) => {
  initSSE(req, res);
  benchmarkClients.add(res);
  req.on('close', () => benchmarkClients.delete(res));
});

// Get completed results
app.get('/api/benchmark/results', (req, res) => {
  const results = benchmarkRunner?.getResults() ?? [];
  res.json({ results, count: results.length });
});

// Export CSV
app.get('/api/benchmark/export/csv', (req, res) => {
  const csv = benchmarkRunner?.exportCSV() ?? 'No data';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="aeo_benchmark_${Date.now()}.csv"`);
  res.send(csv);
});

// Export JSON
app.get('/api/benchmark/export/json', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="aeo_benchmark_${Date.now()}.json"`);
  res.json(benchmarkRunner?.getResults() ?? []);
});

// Test corpus definition
app.get('/api/benchmark/corpus', (req, res) => {
  res.json(TEST_CORPUS);
});

// Live telemetry
app.get('/api/telemetry', (req, res) => {
  res.json({
    latest: telemetry.getLatest(),
    sampleCount: telemetry.getSamples().length
  });
});

app.get('/api/telemetry/history', (req, res) => {
  const limit = parseInt(req.query.limit ?? '200');
  const samples = telemetry.getSamples();
  res.json(samples.slice(-limit));
});

// SSE stream — telemetry
app.get('/api/telemetry/stream', (req, res) => {
  initSSE(req, res);
  telemetryClients.add(res);
  // Send current history immediately
  const recent = telemetry.getSamples().slice(-50);
  res.write(`data: ${JSON.stringify({ event: 'history', samples: recent })}\n\n`);
  req.on('close', () => telemetryClients.delete(res));
});

// AEO state
app.get('/api/aeo/cache', (req, res) => {
  res.json(aeo.getCacheStats());
});

app.get('/api/aeo/log', (req, res) => {
  res.json(aeo.getPipelineLog());
});

app.post('/api/aeo/cache/clear', (req, res) => {
  aeo.cache.clear();
  res.json({ cleared: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AEO Backend listening on http://localhost:${PORT}`);
  console.log(`Model path: ${engine.modelPath}`);
  console.log(`Set MODEL_PATH env var to point to your gemma-3-1b-it-Q4_K_M.gguf file`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  telemetry.stop();
  await engine.dispose();
  process.exit(0);
});
