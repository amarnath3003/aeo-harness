import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ScatterChart,
  Scatter, ZAxis, Cell
} from 'recharts';
import { api } from '../utils/api';

const COLORS = {
  AEO: '#34d399',
  Baseline: '#60a5fa',
  temp: '#f87171',
  ram: '#fbbf24',
  battery: '#a78bfa',
};

const tooltipStyle = {
  background: '#13151a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  fontSize: 11,
  color: '#e8eaf0'
};

export default function ChartsPage({ telemetrySamples }) {
  const [results, setResults] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [expectedRuns, setExpectedRuns] = useState(null);

  const liveTelemetry = telemetrySamples ?? [];

  useEffect(() => {
    let cancelled = false;
    let interval = null;
    let expectedTotalRuns = null;

    const poll = async () => {
      try {
        if (cancelled) return;
        const d = await api.getResults();
        if (cancelled) return;
        const nextResults = d.results || [];
        setResults(prev => {
          if (prev.length === nextResults.length) {
            const prevTail = prev[prev.length - 1];
            const nextTail = nextResults[nextResults.length - 1];
            if (
              prevTail?.test_id === nextTail?.test_id &&
              prevTail?.pipeline_used === nextTail?.pipeline_used &&
              prevTail?.timestamp === nextTail?.timestamp
            ) {
              return prev;
            }
          }
          return nextResults;
        });
        setLoaded(true);

        if (expectedTotalRuns && d.count >= expectedTotalRuns && interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };

    (async () => {
      try {
        const corpus = await api.getCorpus();
        if (cancelled) return;
        expectedTotalRuns = Array.isArray(corpus) ? corpus.length * 2 : null;
        setExpectedRuns(expectedTotalRuns);
        await poll();
        if (!cancelled) {
          interval = setInterval(poll, 2000);
        }
      } catch {
        if (!cancelled) {
          await poll();
          interval = setInterval(poll, 2000);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, []);

  const completeBenchmark = expectedRuns ? results.length >= expectedRuns : false;

  const benchmarkStartMs = results.length > 0
    ? Math.min(...results.map(r => Date.parse(r.timestamp)).filter(Number.isFinite))
    : null;
  const benchmarkEndMs = completeBenchmark && results.length > 0
    ? Math.max(...results.map(r => Date.parse(r.timestamp)).filter(Number.isFinite))
    : null;

  const telemetryForCharts = benchmarkStartMs
    ? liveTelemetry.filter((sample) => {
        const sampleMs = Date.parse(sample.timestamp);
        if (!Number.isFinite(sampleMs)) return false;
        if (sampleMs < benchmarkStartMs - 1000) return false;
        if (benchmarkEndMs && sampleMs > benchmarkEndMs + 1000) return false;
        return true;
      })
    : liveTelemetry;

  const aeo = results.filter(r => r.pipeline_used === 'AEO' && !r.cache_hit);
  const base = results.filter(r => r.pipeline_used === 'Baseline');

  // Per-test comparison data
  const compData = [...new Set(results.map(r => r.test_id))].map(id => {
    const a = results.find(r => r.test_id === id && r.pipeline_used === 'AEO');
    const b = results.find(r => r.test_id === id && r.pipeline_used === 'Baseline');
    return {
      id,
      cat: a?.category || b?.category,
      aeoTPS: a?.cache_hit ? null : Number(a?.generation_rate_tps) || 0,
      baseTPS: Number(b?.generation_rate_tps) || 0,
      aeoPower: a?.cache_hit ? 0 : Number(a?.power_proxy_core_seconds) || 0,
      basePower: Number(b?.power_proxy_core_seconds) || 0,
      aeoThreads: a?.thread_count || 0,
      baseThreads: b?.thread_count || 0,
      aeoTTFT: a?.cache_hit ? 0 : Number(a?.time_to_first_token_sec) || 0,
      baseTTFT: Number(b?.time_to_first_token_sec) || 0,
      label: `${id} (${a?.category || b?.category})`,
    };
  });

  // Memory profile from telemetry
  const memData = telemetryForCharts.slice(-120).map(s => ({
    t: s.t,
    ram: s.ram_used_mb,
    pipeline: s.pipeline,
  }));

  // Thermal data
  const thermalData = telemetryForCharts.slice(-120).map(s => ({
    t: s.t,
    temp: s.cpu_temp_c,
    pipeline: s.pipeline,
    threads: s.active_threads,
  }));

  // Thread allocation distribution
  const threadDist = results.reduce((acc, r) => {
    const key = `${r.pipeline_used}-${r.thread_count}`;
    if (!acc[key]) acc[key] = { pipeline: r.pipeline_used, threads: r.thread_count, count: 0 };
    acc[key].count++;
    return acc;
  }, {});
  const threadData = Object.values(threadDist).sort((a, b) => a.threads - b.threads);

  const ChartCard = ({ title, children }) => (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <span className="card-title">{title}</span>
      </div>
      <div style={{ padding: '12px 16px 16px' }}>{children}</div>
    </div>
  );

  if (!loaded) return <div style={{ padding: 32, color: 'var(--text2)' }}>Loading...</div>;

  if (results.length === 0 && liveTelemetry.length < 5) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <div>Run the benchmark first to generate chart data.</div>
      </div>
    );
  }

  return (
    <div style={{ overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '2px 2px 0' }}>
        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>Analytics Export</div>
          <div style={{ fontSize: 12, color: 'var(--text2)' }}>Download the chart dataset and telemetry summary in paper-ready CSV or JSON.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn" onClick={api.exportAnalyticsPaperCSV}>Paper CSV</button>
          <button className="btn" onClick={api.exportAnalyticsPaperJSON}>Paper JSON</button>
          <button className="btn" onClick={api.exportAnalyticsFigureSVG}>Figure SVG</button>
        </div>
      </div>

      {completeBenchmark && (
        <div className="status-pill ok" style={{ alignSelf: 'flex-start' }}>
          <span className="dot" />
          Stable analytics loaded — {results.length} records
        </div>
      )}

      {/* Row 1: Power proxy comparison + Thread allocation */}
      <div className="charts-grid">

        <ChartCard title="Power Proxy: AEO vs Baseline (core·seconds)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={compData} margin={{ top: 5, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="id" tick={{ fontSize: 10, fill: '#5f6678' }} />
              <YAxis tick={{ fontSize: 10, fill: '#5f6678' }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="basePower" name="Baseline" fill={COLORS.Baseline} opacity={0.8} radius={[2,2,0,0]} />
              <Bar dataKey="aeoPower" name="AEO" fill={COLORS.AEO} opacity={0.8} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>
            Lower = better battery life. Cache hits = 0 power.
          </div>
        </ChartCard>

        <ChartCard title="CPU Thread Allocation Distribution">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={threadData} margin={{ top: 5, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="threads" tick={{ fontSize: 10, fill: '#5f6678' }} label={{ value: 'Threads', position: 'insideBottom', offset: -10, fontSize: 10, fill: '#5f6678' }} />
              <YAxis tick={{ fontSize: 10, fill: '#5f6678' }} label={{ value: 'Runs', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#5f6678' }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="count" name="Run count" radius={[2,2,0,0]}>
                {threadData.map((entry, i) => (
                  <Cell key={i} fill={entry.pipeline === 'AEO' ? COLORS.AEO : COLORS.Baseline} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row 2: Generation TPS + TTFT comparison */}
      <div className="charts-grid">

        <ChartCard title="Generation Rate: TPS (higher = faster)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={compData} margin={{ top: 5, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="id" tick={{ fontSize: 10, fill: '#5f6678' }} />
              <YAxis tick={{ fontSize: 10, fill: '#5f6678' }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="baseTPS" name="Baseline TPS" fill={COLORS.Baseline} opacity={0.8} radius={[2,2,0,0]} />
              <Bar dataKey="aeoTPS" name="AEO TPS" fill={COLORS.AEO} opacity={0.8} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Time to First Token: seconds (lower = better)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={compData} margin={{ top: 5, right: 10, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="id" tick={{ fontSize: 10, fill: '#5f6678' }} />
              <YAxis tick={{ fontSize: 10, fill: '#5f6678' }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="baseTTFT" name="Baseline TTFT" fill={COLORS.Baseline} opacity={0.8} radius={[2,2,0,0]} />
              <Bar dataKey="aeoTTFT" name="AEO TTFT" fill={COLORS.AEO} opacity={0.8} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row 3: Memory profile + Thermal profile (live telemetry) */}
      <div className="charts-grid">

        <ChartCard title="Memory Profile — RAM Usage Over Time (MB)">
          {memData.length < 3 ? (
            <div style={{ color: 'var(--text2)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
              Collecting telemetry... start a benchmark run to populate.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={memData} margin={{ top: 5, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#5f6678' }} label={{ value: 'time (s)', position: 'insideBottom', offset: -5, fontSize: 9, fill: '#5f6678' }} />
                  <YAxis tick={{ fontSize: 9, fill: '#5f6678' }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} MB`, 'RAM']} />
                  <Line type="monotone" dataKey="ram" stroke={COLORS.ram} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  {/* Reference lines at pipeline transitions */}
                  {memData.filter((d, i) => i > 0 && memData[i-1].pipeline !== d.pipeline && d.pipeline !== 'idle').map((d, i) => (
                    <ReferenceLine key={i} x={d.t} stroke={d.pipeline === 'AEO' ? COLORS.AEO : COLORS.Baseline} strokeDasharray="4 2" strokeWidth={1} label={{ value: d.pipeline, fontSize: 8, fill: d.pipeline === 'AEO' ? COLORS.AEO : COLORS.Baseline }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>
                Vertical lines mark pipeline transitions. AEO Token Pruner reduces peak RAM during multimodal context.
              </div>
            </>
          )}
        </ChartCard>

        <ChartCard title="Thermal Stability Profile — CPU Temperature (°C)">
          {thermalData.length < 3 ? (
            <div style={{ color: 'var(--text2)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
              Collecting thermal data... (synthetic if no thermal sensor)
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={thermalData} margin={{ top: 5, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#5f6678' }} label={{ value: 'time (s)', position: 'insideBottom', offset: -5, fontSize: 9, fill: '#5f6678' }} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#5f6678' }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}°C`, 'Temp']} />
                  <ReferenceLine y={75} stroke="rgba(248,113,113,0.4)" strokeDasharray="6 3" label={{ value: 'throttle threshold', fontSize: 8, fill: 'var(--red)' }} />
                  <ReferenceLine y={60} stroke="rgba(251,191,36,0.3)" strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="temp" stroke={COLORS.temp} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  {thermalData.filter((d, i) => i > 0 && thermalData[i-1].pipeline !== d.pipeline && d.pipeline !== 'idle').map((d, i) => (
                    <ReferenceLine key={i} x={d.t} stroke={d.pipeline === 'AEO' ? COLORS.AEO : COLORS.Baseline} strokeDasharray="4 2" strokeWidth={1} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 4 }}>
                AEO Compute Allocator reduces thread count for low-urgency queries → lower thermal load.
                Red dashed line = thermal throttle threshold (75°C). May be synthetic if no sensor.
              </div>
            </>
          )}
        </ChartCard>
      </div>

      {/* Row 4: Battery drain + Thread vs Power scatter */}
      <div className="charts-grid">

        <ChartCard title="Battery Drain Simulation Over Session">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart
              data={telemetryForCharts.slice(-120).map(s => ({ t: s.t, bat: s.battery_pct, pipeline: s.pipeline }))}
              margin={{ top: 5, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#5f6678' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#5f6678' }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v.toFixed(1)}%`, 'Battery']} />
              <ReferenceLine y={20} stroke="rgba(248,113,113,0.4)" strokeDasharray="4 3" label={{ value: 'critical', fontSize: 8, fill: 'var(--red)' }} />
              <Line type="monotone" dataKey="bat" stroke={COLORS.battery} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Thread Count vs Power Proxy (scatter)">
          {results.length === 0 ? (
            <div style={{ color: 'var(--text2)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>Run benchmark to populate</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart margin={{ top: 5, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="threads" name="Threads" type="number" domain={[0, 9]} tick={{ fontSize: 9, fill: '#5f6678' }} label={{ value: 'threads', position: 'insideBottom', offset: -5, fontSize: 9, fill: '#5f6678' }} />
                <YAxis dataKey="power" name="Power (cs)" tick={{ fontSize: 9, fill: '#5f6678' }} />
                <ZAxis range={[40, 80]} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter
                  name="Baseline"
                  data={base.map(r => ({ threads: r.thread_count, power: r.power_proxy_core_seconds }))}
                  fill={COLORS.Baseline}
                  opacity={0.7}
                />
                <Scatter
                  name="AEO"
                  data={aeo.map(r => ({ threads: r.thread_count, power: r.power_proxy_core_seconds }))}
                  fill={COLORS.AEO}
                  opacity={0.7}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

    </div>
  );
}
