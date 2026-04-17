import React, { useState, useEffect, useRef } from 'react';
import './index.css';
import ChatPage from './pages/ChatPage';
import BenchmarkPage from './pages/BenchmarkPage';
import ChartsPage from './pages/ChartsPage';
import { api, createTelemetryStream } from './utils/api';

export default function App() {
  const [tab, setTab] = useState('chat');
  const [aeoEnabled, setAeoEnabled] = useState(true);
  const [status, setStatus] = useState(null);
  const [sensors, setSensors] = useState({
    battery_pct: 80, ram_used_mb: 0, cpu_load_pct: 0,
    cpu_temp_c: 0, active_threads: 4, battery_real: 80
  });
  const [telemetrySamples, setTelemetrySamples] = useState([]);
  const [deviceState, setDeviceState] = useState({ batteryPct: 80, ramUsedPct: 0.4 });
  const esRef = useRef(null);

  useEffect(() => {
    // Load status
    api.getStatus().then(setStatus).catch(() => {});

    // Start telemetry stream
    esRef.current = createTelemetryStream((sample) => {
      setSensors(s => ({ ...s, ...sample }));
      setTelemetrySamples(prev => {
        const next = [...prev, sample];
        return next.slice(-300); // keep last 300 samples (~2.5 min)
      });
      // Update device state for AEO inference
      setDeviceState({
        batteryPct: Math.round(sample.battery_pct || 80),
        ramUsedPct: sample.ram_used_mb ? Math.min(0.95, sample.ram_used_mb / 8192) : 0.4
      });
    });

    // Poll status every 10s
    const interval = setInterval(() => {
      api.getStatus().then(setStatus).catch(() => {});
    }, 10000);

    return () => {
      esRef.current?.close();
      clearInterval(interval);
    };
  }, []);

  const bat = sensors.battery_pct || 80;
  const batColor = bat < 20 ? 'var(--red)' : bat < 40 ? 'var(--amber)' : 'var(--green)';
  const tempC = sensors.cpu_temp_c || 0;
  const tempColor = tempC > 75 ? 'var(--red)' : tempC > 60 ? 'var(--amber)' : 'var(--green)';

  const modelStatus = status?.modelLoaded
    ? { cls: 'ok', label: 'Model loaded' }
    : status?.isMock
    ? { cls: 'mock', label: 'Mock mode (no model)' }
    : { cls: 'err', label: 'Backend offline' };

  return (
    <div className="app-root">
      <div className="topbar">
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text0)' }}>AEO</span>
          <span style={{ fontSize: 10, color: 'var(--text2)', letterSpacing: '0.02em' }}>Research Harness · gemma-3-1b-it</span>
        </div>

        {/* Tabs */}
        <div className="tab-nav" style={{ flex: 1 }}>
          {[
            { id: 'chat', label: 'Chat' },
            { id: 'benchmark', label: 'Benchmark Runner' },
            { id: 'charts', label: 'Analytics' },
          ].map(t => (
            <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* AEO Toggle */}
        <div className="toggle-wrap" style={{ flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--text1)' }}>AEO Layer</span>
          <div className={`toggle ${aeoEnabled ? 'on' : ''}`} onClick={() => setAeoEnabled(a => !a)}>
            <div className="toggle-knob" />
          </div>
          <span style={{ fontSize: 11, fontWeight: 500, color: aeoEnabled ? 'var(--green)' : 'var(--red)', minWidth: 24 }}>
            {aeoEnabled ? 'ON' : 'OFF'}
          </span>
        </div>

        {/* Live sensors */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', borderLeft: '1px solid var(--border)', paddingLeft: 12, flexShrink: 0 }}>
          <SensorPill label="BAT" value={`${Math.round(bat)}%`} color={batColor} />
          <SensorPill label="TEMP" value={`${Math.round(tempC)}°C`} color={tempColor} />
          <SensorPill label="CPU" value={`${Math.round(sensors.cpu_load_pct || 0)}%`} color="var(--text1)" />
          <SensorPill label="RAM" value={`${Math.round(sensors.ram_used_mb || 0)}MB`} color="var(--text1)" />
          <SensorPill label="THR" value={`${sensors.active_threads || 4}T`} color="var(--blue)" />
        </div>

        {/* Model status */}
        <div className={`status-pill ${modelStatus.cls}`} style={{ flexShrink: 0 }}>
          <div className="dot" />
          {modelStatus.label}
        </div>
      </div>

      <div className="tab-content">
        {tab === 'chat' && <ChatPage aeoEnabled={aeoEnabled} deviceState={deviceState} />}
        {tab === 'benchmark' && <BenchmarkPage />}
        {tab === 'charts' && <ChartsPage telemetrySamples={telemetrySamples} />}
      </div>
    </div>
  );
}

function SensorPill({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 38 }}>
      <span style={{ fontSize: 9, color: 'var(--text2)', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--mono)', color }}>{value}</span>
    </div>
  );
}
