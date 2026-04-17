import React, { useState, useEffect, useRef } from 'react';
import { api, createBenchmarkStream } from '../utils/api';

const CATEGORY_COLORS = {
  A: 'var(--red)',
  B: 'var(--green)',
  C: 'var(--amber)',
  D: 'var(--purple)',
};

const PIPELINE_COLORS = {
  AEO: 'var(--green)',
  Baseline: 'var(--blue)',
};

export default function BenchmarkPage() {
  const [status, setStatus] = useState('idle'); // idle | running | done
  const [progress, setProgress] = useState({ completed: 0, total: 0, pipeline: '', testId: '' });
  const [results, setResults] = useState([]);
  const [log, setLog] = useState([]);
  const eventSource = useRef(null);
  const tableRef = useRef(null);

  function addLog(msg, type = '') {
    setLog(l => [...l.slice(-200), { msg, type, ts: new Date().toLocaleTimeString() }]);
  }

  async function startBenchmark() {
    if (status === 'running') return;
    setResults([]);
    setLog([]);
    setStatus('running');
    setProgress({ completed: 0, total: 0, pipeline: '', testId: '' });

    // Open SSE stream first
    eventSource.current?.close();
    eventSource.current = createBenchmarkStream((event) => {
      if (event.event === 'start') {
        addLog(`Benchmark started — ${event.total} runs`, 'info');
        setProgress(p => ({ ...p, total: event.total }));
      } else if (event.event === 'progress') {
        setProgress({ completed: event.completed, total: event.total, pipeline: event.pipeline, testId: event.testId });
        addLog(`[${event.testId}] ${event.pipeline} — running...`);
      } else if (event.event === 'result') {
        const r = event.result;
        setResults(prev => [...prev, r]);
        const flag = r.cache_hit ? ' 🎯 CACHE HIT' : '';
        addLog(
          `[${r.test_id}] ${r.pipeline_used} | threads=${r.thread_count} | tps=${r.generation_rate_tps} | power=${r.power_proxy_core_seconds}cs${flag}`,
          r.cache_hit ? 'success' : r.pipeline_used === 'AEO' ? 'info' : ''
        );
        setTimeout(() => tableRef.current?.scrollTo(0, tableRef.current.scrollHeight), 50);
      } else if (event.event === 'complete') {
        addLog(`Benchmark complete — ${event.count} records collected`, 'success');
        setStatus('done');
      } else if (event.event === 'error') {
        addLog(`Error: ${event.message}`, 'error');
        setStatus('done');
      }
    });

    try {
      await api.startBenchmark();
    } catch (err) {
      addLog(`Failed to start: ${err.message}`, 'error');
      setStatus('idle');
    }
  }

  useEffect(() => () => eventSource.current?.close(), []);

  // Summary stats
  const aeoResults = results.filter(r => r.pipeline_used === 'AEO');
  const baseResults = results.filter(r => r.pipeline_used === 'Baseline');
  const cacheHits = aeoResults.filter(r => r.cache_hit).length;

  const avg = (arr, key) => arr.length === 0 ? 0 : (arr.reduce((s, r) => s + (Number(r[key]) || 0), 0) / arr.length);

  const aeoTPS = avg(aeoResults.filter(r => !r.cache_hit), 'generation_rate_tps');
  const baseTPS = avg(baseResults, 'generation_rate_tps');
  const aeoPower = avg(aeoResults, 'power_proxy_core_seconds');
  const basePower = avg(baseResults, 'power_proxy_core_seconds');
  const powerSavingPct = basePower > 0 ? ((basePower - aeoPower) / basePower * 100).toFixed(1) : '0';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', height: '100%', overflow: 'hidden' }}>

      {/* LEFT — controls + table */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Top controls */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg1)', display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          <button className="btn primary" onClick={startBenchmark} disabled={status === 'running'}>
            {status === 'running' ? 'Running...' : 'Run Full Benchmark'}
          </button>
          <button className="btn" onClick={api.exportCSV} disabled={results.length === 0}>Export CSV</button>
          <button className="btn" onClick={api.exportJSON} disabled={results.length === 0}>Export JSON</button>

          {status === 'running' && (
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11, color: 'var(--text1)' }}>
                <span>{progress.pipeline} · {progress.testId}</span>
                <span>{progress.completed}/{progress.total}</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: progress.total ? `${(progress.completed/progress.total*100).toFixed(0)}%` : '0%' }} />
              </div>
            </div>
          )}

          {status === 'done' && (
            <span className="status-pill ok">
              <span className="dot" />
              Complete — {results.length} records
            </span>
          )}
        </div>

        {/* Summary stat row */}
        {results.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg1)', flexShrink: 0 }}>
            {[
              { label: 'Cache Hits', value: cacheHits, suffix: '', color: 'var(--purple)' },
              { label: 'AEO avg TPS', value: aeoTPS.toFixed(1), suffix: ' t/s', color: 'var(--green)' },
              { label: 'Baseline avg TPS', value: baseTPS.toFixed(1), suffix: ' t/s', color: 'var(--blue)' },
              { label: 'AEO power', value: aeoPower.toFixed(2), suffix: ' cs', color: 'var(--green)' },
              { label: 'Power saving', value: `${powerSavingPct}%`, suffix: '', color: parseFloat(powerSavingPct) > 0 ? 'var(--green)' : 'var(--red)' },
            ].map((s, i) => (
              <div key={i} className="metric-card" style={{ padding: '8px 12px' }}>
                <div className="metric-label">{s.label}</div>
                <div className="metric-value" style={{ fontSize: 18, color: s.color }}>{s.value}{s.suffix}</div>
              </div>
            ))}
          </div>
        )}

        {/* Results table */}
        <div ref={tableRef} style={{ flex: 1, overflow: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>⚗</div>
              <div style={{ fontSize: 14 }}>Run the benchmark to collect data.</div>
              <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text2)' }}>
                Tests: A (High-Urgency) · B (Low-Urgency) · C (Token Pruner) · D (Cache)
              </div>
            </div>
          ) : (
            <table className="result-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Cat</th>
                  <th>Pipeline</th>
                  <th>Threads</th>
                  <th>TTFT (s)</th>
                  <th>TPS</th>
                  <th>Total (s)</th>
                  <th>Power (cs)</th>
                  <th>Cache</th>
                  <th>Compression</th>
                  <th>Urgency</th>
                  <th>RAM Δ (MB)</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className={r.pipeline_used === 'AEO' ? 'aeo-row' : 'base-row'}>
                    <td style={{ color: 'var(--text2)' }}>{r.test_id}</td>
                    <td>
                      <span style={{ color: CATEGORY_COLORS[r.category] || 'var(--text0)', fontWeight: 600 }}>
                        {r.category}
                      </span>
                    </td>
                    <td style={{ color: PIPELINE_COLORS[r.pipeline_used] }}>{r.pipeline_used}</td>
                    <td style={{ color: r.thread_count === 0 ? 'var(--purple)' : r.thread_count > 4 ? 'var(--red)' : r.thread_count < 4 ? 'var(--green)' : 'var(--text0)' }}>
                      {r.thread_count === 0 ? '— (cache)' : r.thread_count}
                    </td>
                    <td>{r.time_to_first_token_sec === 0 ? <span className="c-purple">0 (cache)</span> : r.time_to_first_token_sec}</td>
                    <td>{r.generation_rate_tps === 'Infinity' || r.generation_rate_tps > 9000 ? <span className="c-purple">∞</span> : r.generation_rate_tps}</td>
                    <td>{r.total_generation_time_sec}</td>
                    <td style={{ color: r.power_proxy_core_seconds < 0.1 ? 'var(--green)' : r.power_proxy_core_seconds > 5 ? 'var(--red)' : 'var(--text0)' }}>
                      {r.power_proxy_core_seconds}
                    </td>
                    <td>{r.cache_hit ? <span className="c-purple">HIT</span> : <span className="c-faint">miss</span>}</td>
                    <td>{r.compression_ratio_pct !== '0.0' ? <span className="c-amber">{r.compression_ratio_pct}%</span> : <span className="c-faint">—</span>}</td>
                    <td style={{ fontSize: 10, color: r.urgency_level === 'CRITICAL' ? 'var(--red)' : r.urgency_level === 'HIGH' ? 'var(--amber)' : 'var(--text2)' }}>
                      {r.urgency_level}
                    </td>
                    <td style={{ color: r.ram_delta_mb > 50 ? 'var(--red)' : 'var(--text2)' }}>
                      {r.ram_delta_mb > 0 ? '+' : ''}{r.ram_delta_mb}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* RIGHT — log */}
      <div style={{ borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg1)' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="section-label" style={{ margin: 0 }}>Event Log</span>
          <button className="btn" style={{ fontSize: 10, padding: '3px 8px' }} onClick={() => setLog([])}>Clear</button>
        </div>
        <div className="log-terminal" style={{ flex: 1, margin: '8px', borderRadius: 6 }}>
          {log.length === 0 ? (
            <div style={{ color: 'var(--text2)' }}>Waiting for benchmark events...</div>
          ) : log.map((l, i) => (
            <div key={i} className={`log-line ${l.type}`}>
              <span style={{ color: 'var(--text2)', userSelect: 'none' }}>{l.ts} </span>
              {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
