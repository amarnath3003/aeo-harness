import axios from 'axios';

const BASE = '/api';

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

  exportCSV: () => {
    window.open(`${BASE}/benchmark/export/csv`, '_blank');
  },

  exportJSON: () => {
    window.open(`${BASE}/benchmark/export/json`, '_blank');
  }
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
