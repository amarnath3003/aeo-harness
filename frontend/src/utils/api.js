import axios from 'axios';

const BASE = '/api';

function parseFilename(contentDisposition, fallbackName) {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8''|\")?([^;\"\n]+)/i);
  if (!match?.[1]) return fallbackName;
  try {
    return decodeURIComponent(match[1].replace(/\"/g, '').trim());
  } catch {
    return match[1].replace(/\"/g, '').trim();
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

  exportCSV: () => downloadBenchmarkExport('csv'),

  exportJSON: () => downloadBenchmarkExport('json')
};

export function createBenchmarkStream(onEvent) {
  const es = new EventSource('/api/benchmark/stream');
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {};
  return es;
}

export function createTelemetryStream(onSample) {
  const es = new EventSource('/api/telemetry/stream');
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
