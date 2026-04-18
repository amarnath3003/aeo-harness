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

function downloadBlobFile(fileName, blob) {
  const blobUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(blobUrl);
}

function downloadJsonFile(fileName, payload) {
  downloadTextFile(fileName, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
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

function sanitizeFilePart(value) {
  return String(value || 'graph')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'graph';
}

function graphRowsToCsv(graph) {
  const directRows = Array.isArray(graph?.data) ? graph.data : [];
  if (directRows.length > 0) {
    const keys = Array.from(directRows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set()));

    return toCsv(directRows, keys.map((key) => ({
      key,
      label: key,
      value: (row) => row?.[key]
    })));
  }

  const seriesRows = (graph?.series || [])
    .filter((series) => Array.isArray(series?.data))
    .flatMap((series) => series.data.map((point) => ({
      series_key: series.key,
      series_label: series.label,
      ...(point || {})
    })));

  if (seriesRows.length === 0) {
    return 'note\nNo data for this graph';
  }

  const keys = Array.from(seriesRows.reduce((set, row) => {
    Object.keys(row || {}).forEach((key) => set.add(key));
    return set;
  }, new Set(['series_key', 'series_label'])));

  return toCsv(seriesRows, keys.map((key) => ({
    key,
    label: key,
    value: (row) => row?.[key]
  })));
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

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function maxOf(series, accessor) {
  return series.reduce((max, item) => Math.max(max, Number(accessor(item)) || 0), 0);
}

function buildPath(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

function buildAnalyticsFigureSvg(results, telemetrySamples) {
  const report = summarizeAnalyticsRows(results, telemetrySamples);
  const comparison = report.tables.comparison;
  const threadDistribution = report.tables.threadDistribution;
  const memoryProfile = report.tables.memoryProfile;
  const thermalProfile = report.tables.thermalProfile;
  const batteryProfile = report.tables.batteryProfile;

  const width = 1400;
  const height = 1200;
  const panelW = 630;
  const panelH = 300;
  const leftX = 60;
  const rightX = 710;
  const topY = 150;
  const row2Y = 540;
  const row3Y = 930;
  const axisColor = '#c7cbd6';
  const gridColor = '#eef1f7';
  const textColor = '#172033';

  const compareMax = Math.max(
    maxOf(comparison, row => row.baseline_power_core_seconds),
    maxOf(comparison, row => row.aeo_power_core_seconds),
    maxOf(comparison, row => row.baseline_tps),
    maxOf(comparison, row => row.aeo_tps),
    maxOf(comparison, row => row.baseline_ttft_seconds),
    maxOf(comparison, row => row.aeo_ttft_seconds),
    1
  );
  const threadMax = Math.max(...threadDistribution.map(row => row.count), 1);
  const ramMax = Math.max(...memoryProfile.map(row => Number(row.ram_used_mb) || 0), 1);
  const tempMax = Math.max(...thermalProfile.map(row => Number(row.cpu_temp_c) || 0), 1);
  const batteryMin = Math.min(...batteryProfile.map(row => Number(row.battery_pct) || 100), 100);

  const summary = report.summary;
  const title = escapeXml(report.title);

  const barPanel = (titleText, x, y, data, barAKey, barBKey, barALabel, barBLabel, valueLabel, maxValue, colorA, colorB) => {
    const chartPad = 44;
    const chartW = panelW - chartPad * 2;
    const chartH = panelH - 95;
    const barGroupW = data.length > 0 ? chartW / data.length : chartW;
    const barW = Math.max(8, Math.min(26, barGroupW * 0.28));
    const bars = data.map((item, index) => {
      const xCenter = x + chartPad + index * barGroupW + barGroupW / 2;
      const barA = (Number(item[barAKey]) || 0) / maxValue;
      const barB = (Number(item[barBKey]) || 0) / maxValue;
      const barBase = y + panelH - 46;
      const aH = Math.max(1, barA * chartH);
      const bH = Math.max(1, barB * chartH);
      return `
        <g>
          <rect x="${xCenter - barW - 4}" y="${barBase - aH}" width="${barW}" height="${aH}" fill="${colorA}" rx="3"/>
          <rect x="${xCenter + 4}" y="${barBase - bH}" width="${barW}" height="${bH}" fill="${colorB}" rx="3"/>
          <text x="${xCenter}" y="${barBase + 14}" font-size="10" text-anchor="middle" fill="${textColor}">${escapeXml(item.test_id)}</text>
        </g>
      `;
    }).join('');

    return `
      <g>
        <rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="16" fill="#ffffff" stroke="#dde2ee"/>
        <text x="${x + 24}" y="${y + 30}" font-size="18" font-weight="700" fill="${textColor}">${escapeXml(titleText)}</text>
        <text x="${x + 24}" y="${y + 50}" font-size="11" fill="#5b6578">${escapeXml(valueLabel)}</text>
        <line x1="${x + chartPad}" y1="${y + panelH - 46}" x2="${x + panelW - chartPad}" y2="${y + panelH - 46}" stroke="${axisColor}"/>
        <line x1="${x + chartPad}" y1="${y + 55}" x2="${x + chartPad}" y2="${y + panelH - 46}" stroke="${axisColor}"/>
        ${bars}
        <g>
          <rect x="${x + panelW - 172}" y="${y + 18}" width="12" height="12" fill="${colorA}" rx="2"/>
          <text x="${x + panelW - 154}" y="${y + 28}" font-size="11" fill="${textColor}">${escapeXml(barALabel)}</text>
          <rect x="${x + panelW - 172}" y="${y + 36}" width="12" height="12" fill="${colorB}" rx="2"/>
          <text x="${x + panelW - 154}" y="${y + 46}" font-size="11" fill="${textColor}">${escapeXml(barBLabel)}</text>
        </g>
      </g>
    `;
  };

  const linePanel = (titleText, subtitle, x, y, series, seriesA, seriesB, labelA, labelB, maxY, minY = 0) => {
    const chartPad = 44;
    const chartW = panelW - chartPad * 2;
    const chartH = panelH - 95;
    const sampleCount = Math.max(seriesA.length, seriesB.length, 1);
    const scaleX = (index) => x + chartPad + (sampleCount === 1 ? chartW / 2 : (index / (sampleCount - 1)) * chartW);
    const scaleY = (value) => {
      const clamped = Math.max(minY, Math.min(maxY, value));
      const ratio = (clamped - minY) / (maxY - minY || 1);
      return y + 55 + (chartH - ratio * chartH);
    };
    const pointsA = seriesA.map((value, index) => ({ x: scaleX(index), y: scaleY(value) }));
    const pointsB = seriesB.map((value, index) => ({ x: scaleX(index), y: scaleY(value) }));
    const pathA = pointsA.length > 0 ? `<path d="${buildPath(pointsA)}" fill="none" stroke="#34d399" stroke-width="2.5"/>` : '';
    const pathB = pointsB.length > 0 ? `<path d="${buildPath(pointsB)}" fill="none" stroke="#60a5fa" stroke-width="2.5"/>` : '';
    const points = pointsA.length > 0 ? pointsA : pointsB;
    const dots = points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.5" fill="#172033"/>`).join('');

    return `
      <g>
        <rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="16" fill="#ffffff" stroke="#dde2ee"/>
        <text x="${x + 24}" y="${y + 30}" font-size="18" font-weight="700" fill="${textColor}">${escapeXml(titleText)}</text>
        <text x="${x + 24}" y="${y + 50}" font-size="11" fill="#5b6578">${escapeXml(subtitle)}</text>
        <line x1="${x + chartPad}" y1="${y + panelH - 46}" x2="${x + panelW - chartPad}" y2="${y + panelH - 46}" stroke="${axisColor}"/>
        <line x1="${x + chartPad}" y1="${y + 55}" x2="${x + chartPad}" y2="${y + panelH - 46}" stroke="${axisColor}"/>
        <line x1="${x + chartPad}" y1="${scaleY(minY)}" x2="${x + panelW - chartPad}" y2="${scaleY(minY)}" stroke="${gridColor}" stroke-dasharray="4 4"/>
        ${pathA}
        ${pathB}
        ${dots}
        <g>
          <rect x="${x + panelW - 170}" y="${y + 18}" width="12" height="12" fill="#34d399" rx="2"/>
          <text x="${x + panelW - 152}" y="${y + 28}" font-size="11" fill="${textColor}">${escapeXml(labelA)}</text>
          <rect x="${x + panelW - 170}" y="${y + 36}" width="12" height="12" fill="#60a5fa" rx="2"/>
          <text x="${x + panelW - 152}" y="${y + 46}" font-size="11" fill="${textColor}">${escapeXml(labelB)}</text>
        </g>
      </g>
    `;
  };

  const comparePowerPanel = barPanel(
    'Power Proxy by Test Case',
    leftX,
    topY,
    comparison,
    'baseline_power_core_seconds',
    'aeo_power_core_seconds',
    'Baseline',
    'AEO',
    'core·seconds, lower is better',
    compareMax,
    '#60a5fa',
    '#34d399'
  );

  const threadsPanel = barPanel(
    'Thread Allocation Distribution',
    rightX,
    topY,
    threadDistribution.map(row => ({
      test_id: `${row.pipeline_used}-${row.threads}`,
      baseline_power_core_seconds: row.pipeline_used === 'Baseline' ? row.count : 0,
      aeo_power_core_seconds: row.pipeline_used === 'AEO' ? row.count : 0
    })),
    'baseline_power_core_seconds',
    'aeo_power_core_seconds',
    'Baseline count',
    'AEO count',
    'runs',
    threadMax,
    '#60a5fa',
    '#34d399'
  );

  const ramSeries = memoryProfile.map(row => Number(row.ram_used_mb) || 0);
  const tempSeries = thermalProfile.map(row => Number(row.cpu_temp_c) || 0);
  const batterySeries = batteryProfile.map(row => Number(row.battery_pct) || 0);

  const ramPoints = ramSeries.map((value, index) => value);
  const tempPoints = tempSeries.map((value, index) => value);
  const batteryPoints = batterySeries.map((value, index) => value);

  const ramPanel = linePanel(
    'Telemetry: RAM Usage Over Time',
    'live memory profile from benchmark/telemetry stream',
    leftX,
    row2Y,
    memoryProfile,
    ramPoints,
    [],
    'RAM',
    '',
    ramMax,
    0
  );

  const thermalPanel = linePanel(
    'Telemetry: CPU Temperature and Battery',
    'temperature and battery trend during benchmark session',
    rightX,
    row2Y,
    thermalProfile,
    tempPoints,
    batteryPoints,
    'CPU temp',
    'Battery %',
    Math.max(tempMax, 100),
    0
  );

  const legendText = `Benchmark rows: ${report.counts.benchmarkRows} | telemetry samples: ${report.counts.telemetrySamples} | power saving: ${summary.benchmark.powerSavingPct}% | peak temp: ${summary.telemetry.peakCpuTempC}°C`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f7f8fb"/>
  <text x="60" y="54" font-size="30" font-weight="700" fill="${textColor}">${title}</text>
  <text x="60" y="82" font-size="14" fill="#5b6578">Paper-ready analytics figure pack | generated ${escapeXml(report.generatedAt)}</text>
  <text x="60" y="108" font-size="13" fill="#334155">${escapeXml(legendText)}</text>
  <text x="60" y="132" font-size="12" fill="#5b6578">Summary: Baseline TPS ${summary.benchmark.baselineAvgTps} | AEO TPS ${summary.benchmark.aeoAvgTps} | Baseline power ${summary.benchmark.baselineAvgPowerCoreSeconds} | AEO power ${summary.benchmark.aeoAvgPowerCoreSeconds}</text>
  ${comparePowerPanel}
  ${threadsPanel}
  ${ramPanel}
  ${thermalPanel}
</svg>`;
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
  downloadBlobFile(fileName, response.data);
}

async function downloadAnalyticsPythonImage(graph, style = 'seaborn') {
  const response = await axios.post(
    `${BASE}/analytics/plot/export`,
    { graph, style },
    { responseType: 'blob' }
  );

  const graphPart = sanitizeFilePart(graph?.graphId || graph?.title || 'graph');
  const fallbackName = `aeo_${graphPart}_${sanitizeFilePart(style)}_${Date.now()}.png`;
  const fileName = parseFilename(response.headers['content-disposition'], fallbackName);
  downloadBlobFile(fileName, response.data);
}

export const api = {
  getStatus: () => axios.get(`${BASE}/status`).then(r => r.data),

  infer: (query, sensorContext, deviceState, useAEO) =>
    axios.post(`${BASE}/infer`, { query, sensorContext, deviceState, useAEO })
      .then(r => r.data),

  startBenchmark: () =>
    axios.post(`${BASE}/benchmark/start`).then(r => r.data),

  startCacheBenchmark: () =>
    axios.post(`${BASE}/benchmark/start-cache`).then(r => r.data),

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
  exportAnalyticsPaperJSON: () => downloadAnalyticsPaper('json'),
  exportAnalyticsGraphDataBundle: (bundle) => {
    const fileName = `aeo_analytics_graph_data_${Date.now()}.json`;
    downloadJsonFile(fileName, bundle);
  },
  exportAnalyticsGraphCsvPack: (bundle) => {
    const timestamp = Date.now();
    const graphs = Array.isArray(bundle?.graphs) ? bundle.graphs : [];

    graphs.forEach((graph, index) => {
      const part = sanitizeFilePart(graph?.graphId || graph?.title || `graph_${index + 1}`);
      const fileName = `aeo_analytics_${String(index + 1).padStart(2, '0')}_${part}_${timestamp}.csv`;
      downloadTextFile(fileName, graphRowsToCsv(graph), 'text/csv;charset=utf-8');
    });
  },
  exportAnalyticsGraphPythonImage: (graph, style = 'seaborn') =>
    downloadAnalyticsPythonImage(graph, style),
  exportAnalyticsFigureSVG: async () => {
    const [resultsResponse, telemetryResponse] = await Promise.all([
      api.getResults(),
      api.getTelemetryHistory(300)
    ]);

    const svg = buildAnalyticsFigureSvg(resultsResponse.results || [], telemetryResponse || []);
    downloadTextFile(`aeo_analytics_figure_${Date.now()}.svg`, svg, 'image/svg+xml;charset=utf-8');
  }
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
