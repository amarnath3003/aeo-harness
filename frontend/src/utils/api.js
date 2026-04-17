import axios from 'axios';

const BASE = '/api';
const PAPER_TITLE = 'AEO Research Harness Paper Export';

function getStreamBaseUrl() {
  if (process.env.REACT_APP_API_BASE) return process.env.REACT_APP_API_BASE;
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001';
  }
  return window.location.origin;
}

function parseFilename(contentDisposition, fallbackName) {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8''|\")?([^;\"\n]+)/i);
  if (!match?.[1]) return fallbackName;
  try {
    return decodeURIComponent(match[1].replace(/\"/g, '').trim());
  } catch {
    return match[1].replace(/\"/g, '').trim();
  }
}


function downloadTextFile(fileName, content, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const blobUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(blobUrl);
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function toCsv(rows, columns) {
  if (!rows || rows.length === 0) {
    return columns.map(column => escapeCsvValue(column.label || column.key)).join(',');
  }

  const header = columns.map(column => escapeCsvValue(column.label || column.key)).join(',');
  const body = rows.map(row => columns.map(column => escapeCsvValue(column.value(row))).join(','));
  return [header, ...body].join('\n');
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function average(rows, key) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeBenchmarkRows(results) {
  const aeoRows = results.filter(r => r.pipeline_used === 'AEO');
  const baselineRows = results.filter(r => r.pipeline_used === 'Baseline');
  const cacheHits = aeoRows.filter(r => r.cache_hit).length;

  return {
    generatedAt: new Date().toISOString(),
    exportType: 'benchmark_paper',
    title: PAPER_TITLE,
    counts: {
      totalRows: results.length,
      baselineRows: baselineRows.length,
      aeoRows: aeoRows.length,
      cacheHits,
      cacheHitRatePct: results.length > 0 ? round((cacheHits / Math.max(aeoRows.length, 1)) * 100, 1) : 0
    },
    summary: {
      baseline: {
        avgTps: round(average(baselineRows, 'generation_rate_tps')),
        avgPowerCoreSeconds: round(average(baselineRows, 'power_proxy_core_seconds')),
        avgTtftSeconds: round(average(baselineRows, 'time_to_first_token_sec')),
        avgRamDeltaMb: round(average(baselineRows, 'ram_delta_mb'))
      },
      aeo: {
        avgTps: round(average(aeoRows.filter(r => !r.cache_hit), 'generation_rate_tps')),
        avgPowerCoreSeconds: round(average(aeoRows, 'power_proxy_core_seconds')),
        avgTtftSeconds: round(average(aeoRows.filter(r => !r.cache_hit), 'time_to_first_token_sec')),
        avgRamDeltaMb: round(average(aeoRows, 'ram_delta_mb'))
      }
    },
    rows: results.map((row) => ({
      test_id: row.test_id,
      category: row.category,
      category_label: row.category_label,
      pipeline_used: row.pipeline_used,
      threads: row.thread_count,
      urgency_level: row.urgency_level,
      cache_hit: row.cache_hit,
      compression_ratio_pct: row.compression_ratio_pct,
      generation_rate_tps: row.generation_rate_tps,
      time_to_first_token_sec: row.time_to_first_token_sec,
      total_generation_time_sec: row.total_generation_time_sec,
      power_proxy_core_seconds: row.power_proxy_core_seconds,
      ram_delta_mb: row.ram_delta_mb,
      aeo_reason: row.aeo_reason,
      timestamp: row.timestamp
    }))
  };
}

function benchmarkPaperCsv(results) {
  const columns = [
    { key: 'test_id' },
    { key: 'category' },
    { key: 'category_label' },
    { key: 'pipeline_used' },
    { key: 'threads' },
    { key: 'urgency_level' },
    { key: 'cache_hit' },
    { key: 'compression_ratio_pct' },
    { key: 'generation_rate_tps' },
    { key: 'time_to_first_token_sec' },
    { key: 'total_generation_time_sec' },
    { key: 'power_proxy_core_seconds' },
    { key: 'ram_delta_mb' },
    { key: 'aeo_reason' },
    { key: 'timestamp' }
  ];
  return toCsv(summarizeBenchmarkRows(results).rows, columns.map(column => ({
    key: column.key,
    label: column.key,
    value: (row) => row[column.key]
  })));
}

function summarizeAnalyticsRows(results, telemetrySamples) {
  const aeoRows = results.filter(r => r.pipeline_used === 'AEO' && !r.cache_hit);
  const baselineRows = results.filter(r => r.pipeline_used === 'Baseline');
  const compData = [...new Set(results.map(r => r.test_id))].map((id) => {
    const a = results.find(r => r.test_id === id && r.pipeline_used === 'AEO');
    const b = results.find(r => r.test_id === id && r.pipeline_used === 'Baseline');
    return {
      test_id: id,
      category: a?.category || b?.category || '',
      aeo_tps: a?.cache_hit ? 0 : round(a?.generation_rate_tps),
      baseline_tps: round(b?.generation_rate_tps),
      aeo_power_core_seconds: a?.cache_hit ? 0 : round(a?.power_proxy_core_seconds),
      baseline_power_core_seconds: round(b?.power_proxy_core_seconds),
      aeo_threads: a?.thread_count || 0,
      baseline_threads: b?.thread_count || 0,
      aeo_ttft_seconds: a?.cache_hit ? 0 : round(a?.time_to_first_token_sec),
      baseline_ttft_seconds: round(b?.time_to_first_token_sec)
    };
  });

  const threadDistribution = Object.values(results.reduce((acc, row) => {
    const key = `${row.pipeline_used}-${row.thread_count}`;
    if (!acc[key]) {
      acc[key] = { pipeline_used: row.pipeline_used, threads: row.thread_count, count: 0 };
    }
    acc[key].count += 1;
    return acc;
  }, {})).sort((a, b) => a.threads - b.threads);

  const memoryProfile = telemetrySamples.slice(-120).map(sample => ({
    t: sample.t,
    ram_used_mb: sample.ram_used_mb,
    pipeline: sample.pipeline
  }));

  const thermalProfile = telemetrySamples.slice(-120).map(sample => ({
    t: sample.t,
    cpu_temp_c: sample.cpu_temp_c,
    pipeline: sample.pipeline,
    active_threads: sample.active_threads
  }));

  const batteryProfile = telemetrySamples.slice(-120).map(sample => ({
    t: sample.t,
    battery_pct: sample.battery_pct,
    pipeline: sample.pipeline
  }));

  const peakTemp = telemetrySamples.reduce((max, sample) => Math.max(max, Number(sample.cpu_temp_c) || 0), 0);
  const minBattery = telemetrySamples.reduce((min, sample) => Math.min(min, Number(sample.battery_pct) || 100), 100);

  return {
    generatedAt: new Date().toISOString(),
    exportType: 'analytics_paper',
    title: PAPER_TITLE,
    counts: {
      benchmarkRows: results.length,
      telemetrySamples: telemetrySamples.length,
      aeoRows: aeoRows.length,
      baselineRows: baselineRows.length
    },
    summary: {
      benchmark: {
        baselineAvgTps: round(average(baselineRows, 'generation_rate_tps')),
        aeoAvgTps: round(average(aeoRows, 'generation_rate_tps')),
        baselineAvgPowerCoreSeconds: round(average(baselineRows, 'power_proxy_core_seconds')),
        aeoAvgPowerCoreSeconds: round(average(aeoRows, 'power_proxy_core_seconds')),
        powerSavingPct: average(baselineRows, 'power_proxy_core_seconds') > 0
          ? round(((average(baselineRows, 'power_proxy_core_seconds') - average(aeoRows, 'power_proxy_core_seconds')) / average(baselineRows, 'power_proxy_core_seconds')) * 100, 1)
          : 0
      },
      telemetry: {
        peakCpuTempC: round(peakTemp),
        minBatteryPct: round(minBattery, 1),
        sampleWindow: Math.min(120, telemetrySamples.length)
      }
    },
    tables: {
      comparison: compData,
      threadDistribution,
      memoryProfile,
      thermalProfile,
      batteryProfile
    }
  };
}

function analyticsPaperCsv(results) {
  const comparison = summarizeAnalyticsRows(results, []).tables.comparison;
  return toCsv(comparison, [
    { key: 'test_id', label: 'test_id', value: row => row.test_id },
    { key: 'category', label: 'category', value: row => row.category },
    { key: 'aeo_tps', label: 'aeo_tps', value: row => row.aeo_tps },
    { key: 'baseline_tps', label: 'baseline_tps', value: row => row.baseline_tps },
    { key: 'aeo_power_core_seconds', label: 'aeo_power_core_seconds', value: row => row.aeo_power_core_seconds },
    { key: 'baseline_power_core_seconds', label: 'baseline_power_core_seconds', value: row => row.baseline_power_core_seconds },
    { key: 'aeo_threads', label: 'aeo_threads', value: row => row.aeo_threads },
    { key: 'baseline_threads', label: 'baseline_threads', value: row => row.baseline_threads },
    { key: 'aeo_ttft_seconds', label: 'aeo_ttft_seconds', value: row => row.aeo_ttft_seconds },
    { key: 'baseline_ttft_seconds', label: 'baseline_ttft_seconds', value: row => row.baseline_ttft_seconds }
  ]);
}

async function downloadBenchmarkPaper(format) {
  const response = await api.getResults();
  const report = summarizeBenchmarkRows(response.results || []);
  const fileName = `aeo_benchmark_paper_${Date.now()}.${format}`;
  if (format === 'json') {
    downloadTextFile(fileName, JSON.stringify(report, null, 2), 'application/json;charset=utf-8');
  } else {
    downloadTextFile(fileName, benchmarkPaperCsv(response.results || []), 'text/csv;charset=utf-8');
  }
}

async function downloadAnalyticsPaper(format) {
  const [resultsResponse, telemetryResponse] = await Promise.all([
    api.getResults(),
    api.getTelemetryHistory(300)
  ]);

  const results = resultsResponse.results || [];
  const telemetrySamples = telemetryResponse || [];
  const report = summarizeAnalyticsRows(results, telemetrySamples);
  const fileName = `aeo_analytics_paper_${Date.now()}.${format}`;
  if (format === 'json') {
    downloadTextFile(fileName, JSON.stringify(report, null, 2), 'application/json;charset=utf-8');
  } else {
    downloadTextFile(fileName, analyticsPaperCsv(results), 'text/csv;charset=utf-8');
  }
}
async function downloadBenchmarkExport(format) {
  const response = await axios.get(`${BASE}/benchmark/export/${format}`, {
    responseType: 'blob'
  });

  const fallbackName = `aeo_benchmark_${Date.now()}.${format}`;
  const fileName = parseFilename(response.headers['content-disposition'], fallbackName);
  const blobUrl = window.URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(blobUrl);
}

export const api = {
  getStatus: () => axios.get(`${BASE}/status`).then(r => r.data),

  infer: (query, sensorContext, deviceState, useAEO) =>
    axios.post(`${BASE}/infer`, { query, sensorContext, deviceState, useAEO })
      .then(r => r.data),

  startBenchmark: () =>
    axios.post(`${BASE}/benchmark/start`).then(r => r.data),

  getResults: () =>
    axios.get(`${BASE}/benchmark/results`).then(r => r.data),

  getCorpus: () =>
    axios.get(`${BASE}/benchmark/corpus`).then(r => r.data),

  getTelemetryHistory: (limit = 200) =>
    axios.get(`${BASE}/telemetry/history?limit=${limit}`).then(r => r.data),

  getCacheStats: () =>
    axios.get(`${BASE}/aeo/cache`).then(r => r.data),

  getAeoLog: () =>
    axios.get(`${BASE}/aeo/log`).then(r => r.data),

  clearCache: () =>
    axios.post(`${BASE}/aeo/cache/clear`).then(r => r.data),

  exportCSV: () => downloadBenchmarkPaper('csv'),

  exportJSON: () => downloadBenchmarkPaper('json'),

  exportBenchmarkPaperCSV: () => downloadBenchmarkPaper('csv'),
  exportBenchmarkPaperJSON: () => downloadBenchmarkPaper('json'),
  exportAnalyticsPaperCSV: () => downloadAnalyticsPaper('csv'),
  exportAnalyticsPaperJSON: () => downloadAnalyticsPaper('json')
};

export function createBenchmarkStream(onEvent) {
  const es = new EventSource(`${getStreamBaseUrl()}/api/benchmark/stream`);
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {};
  return es;
}

export function createTelemetryStream(onSample) {
  const es = new EventSource(`${getStreamBaseUrl()}/api/telemetry/stream`);
  es.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.event === 'history') {
        d.samples.forEach(onSample);
      } else {
        onSample(d);
      }
    } catch {}
  };
  es.onerror = () => {};
  return es;
}
