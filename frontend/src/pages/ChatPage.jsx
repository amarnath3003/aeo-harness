import React, { useState, useRef, useEffect } from 'react';
import { api } from '../utils/api';

const QUICK_PROMPTS = [
  { label: 'SOS — wound', q: 'SOS! I have a deep puncture wound in my thigh and it is bleeding heavily. What do I do right now?', urgency: 'CRITICAL' },
  { label: 'Fire starting', q: 'How do I start a fire in wet conditions?', urgency: 'MEDIUM' },
  { label: 'Find water', q: 'How do I find water in the wilderness?', urgency: 'MEDIUM' },
  { label: 'Square knot', q: 'How do I tie a basic square knot?', urgency: 'LOW' },
  { label: 'Snake bite', q: 'I was bitten by a venomous snake. What are the immediate steps?', urgency: 'HIGH' },
  { label: 'Emergency shelter', q: 'How do I build an emergency shelter quickly?', urgency: 'MEDIUM' },
  { label: '↺ Cache test', q: 'How do I start a fire in wet conditions?', urgency: 'LOW' },
];

const URGENCY_COLORS = {
  CRITICAL: 'var(--red)',
  HIGH: 'var(--amber)',
  MEDIUM: 'var(--text1)',
  LOW: 'var(--teal)',
  CACHED: 'var(--purple)'
};

export default function ChatPage({ aeoEnabled, deviceState }) {
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: 'Edge survival AI online. AEO middleware active. Queries are routed through: Semantic Cache → Token Pruner → Compute Allocator → llama.cpp (gemma-3-1b-it).',
    meta: null
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [stages, setStages] = useState([
    { id: 1, name: 'Semantic Cache', status: 'idle', badge: 'idle' },
    { id: 2, name: 'Token Pruner', status: 'idle', badge: 'idle' },
    { id: 3, name: 'Compute Allocator', status: 'idle', badge: 'idle' },
  ]);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function setStage(idx, status, badge) {
    setStages(prev => prev.map((s, i) => i === idx ? { ...s, status, badge } : s));
  }

  function resetStages() {
    setStages([
      { id: 1, name: 'Semantic Cache', status: 'idle', badge: 'idle' },
      { id: 2, name: 'Token Pruner', status: 'idle', badge: 'idle' },
      { id: 3, name: 'Compute Allocator', status: 'idle', badge: 'idle' },
    ]);
  }

  async function send(queryText) {
    const q = queryText || input.trim();
    if (!q || loading) return;
    setInput('');
    setLoading(true);

    setMessages(m => [...m, { role: 'user', content: q }]);

    // Animate stages if AEO on
    if (aeoEnabled) {
      setStage(0, 'active', 'checking...');
      await new Promise(r => setTimeout(r, 180));
    }

    try {
      const result = await api.infer(q, '', deviceState, aeoEnabled);

      // Update stages based on AEO decision
      if (aeoEnabled && result.aeoDecision) {
        const d = result.aeoDecision;
        if (result.cached) {
          setStage(0, 'hit', 'HIT');
          setStage(1, 'idle', 'skipped');
          setStage(2, 'idle', 'skipped');
        } else {
          setStage(0, 'idle', 'miss');
          if (d.stage2?.ran) {
            setStage(1, 'hit', `-${d.stage2.compressionRatio}%`);
          } else {
            setStage(1, 'idle', 'no-op');
          }
          if (d.stage3?.ran) {
            setStage(2, 'hit', `${d.stage3.threads}T · ${d.stage3.urgencyLevel}`);
          }
        }
      }

      const meta = {
        cached: result.cached,
        pipeline: result.pipeline,
        threads: result.threads,
        isMock: result.isMock,
        metrics: result.metrics,
        aeoDecision: result.aeoDecision,
      };

      setMessages(m => [...m, { role: 'assistant', content: result.response, meta }]);
    } catch (err) {
      setMessages(m => [...m, {
        role: 'assistant',
        content: `Error: ${err.response?.data?.error || err.message}. Is the backend running?`,
        meta: { error: true }
      }]);
    } finally {
      setLoading(false);
      setTimeout(resetStages, 2500);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 240px', height: '100%', overflow: 'hidden' }}>

      {/* LEFT — Pipeline + Quick prompts */}
      <div style={{ borderRight: '1px solid var(--border)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'var(--bg1)', overflow: 'auto' }}>
        <div>
          <div className="section-label">AEO Pipeline</div>
          <div className="stage-list">
            {stages.map(s => (
              <div key={s.id} className={`stage-item ${aeoEnabled ? s.status : 'disabled'}`}>
                <div className="stage-dot" />
                <div className="stage-name">{s.id} · {s.name}</div>
                <div className="stage-badge">{aeoEnabled ? s.badge : 'off'}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
          <div className="section-label">Quick Prompts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {QUICK_PROMPTS.map((p, i) => (
              <button key={i} className="btn" style={{ textAlign: 'left', padding: '6px 8px', fontSize: '11px' }}
                onClick={() => send(p.q)} disabled={loading}>
                <span style={{ color: URGENCY_COLORS[p.urgency], marginRight: 6, fontSize: 9 }}>●</span>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* CENTER — Chat */}
      <div className="chat-container" style={{ background: 'var(--bg0)' }}>
        <div className="chat-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`chat-msg ${msg.role}`}>
              <div className="chat-avatar">
                {msg.role === 'assistant' ? 'AEO' : 'YOU'}
              </div>
              <div>
                <div className="chat-bubble" style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </div>
                {msg.meta && !msg.meta.error && (
                  <div style={{ marginTop: 5, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {msg.meta.cached && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(167,139,250,0.15)', color: 'var(--purple)' }}>
                        cache hit · 0ms
                      </span>
                    )}
                    {msg.meta.threads > 0 && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'var(--bg3)', color: 'var(--text1)' }}>
                        {msg.meta.threads}T · {msg.meta.metrics?.generation_rate_tps?.toFixed(1)} tps
                      </span>
                    )}
                    {msg.meta.metrics?.total_generation_time_sec > 0 && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'var(--bg3)', color: 'var(--text1)' }}>
                        {(msg.meta.metrics.total_generation_time_sec * 1000).toFixed(0)}ms total
                      </span>
                    )}
                    {msg.meta.isMock && (
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 10, background: 'rgba(167,139,250,0.1)', color: 'var(--purple)' }}>
                        mock (no model)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="chat-msg assistant">
              <div className="chat-avatar">AEO</div>
              <div className="chat-bubble" style={{ color: 'var(--text2)' }}>
                <span style={{ fontFamily: 'var(--mono)' }}>processing</span>
                <span style={{ animation: 'blink 1s infinite' }}>_</span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask a survival question... (Enter to send)"
            rows={1}
          />
          <button className="btn primary" onClick={() => send()} disabled={loading || !input.trim()}>
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </div>

      {/* RIGHT — Metrics panel */}
      <div style={{ borderLeft: '1px solid var(--border)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg1)', overflow: 'auto' }}>
        <div className="section-label">Last Inference</div>
        {(() => {
          const last = messages.filter(m => m.role === 'assistant' && m.meta?.metrics).slice(-1)[0];
          const m = last?.meta;
          if (!m) return <div style={{ color: 'var(--text2)', fontSize: 12 }}>No inference yet</div>;
          return (
            <>
              <div className="metric-card">
                <div className="metric-label">TTFT</div>
                <div className="metric-value c-green">{m.cached ? '<1' : ((m.metrics?.time_to_first_token_sec || 0) * 1000).toFixed(0)}<span style={{ fontSize: 12, color: 'var(--text2)' }}> ms</span></div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Generation Rate</div>
                <div className="metric-value c-blue">{m.cached ? '∞' : m.metrics?.generation_rate_tps?.toFixed(1)}<span style={{ fontSize: 12, color: 'var(--text2)' }}> tps</span></div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Power proxy</div>
                <div className="metric-value c-amber">{m.cached ? '0' : m.metrics?.power_proxy_core_seconds?.toFixed(2)}<span style={{ fontSize: 12, color: 'var(--text2)' }}> cs</span></div>
                <div className="metric-sub">core·seconds</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Threads</div>
                <div className="metric-value" style={{ color: m.cached ? 'var(--purple)' : m.threads > 4 ? 'var(--red)' : m.threads < 4 ? 'var(--green)' : 'var(--text0)' }}>
                  {m.cached ? '0 (cache)' : m.threads}
                </div>
              </div>
              {m.aeoDecision?.stage3?.urgencyLevel && (
                <div className="metric-card">
                  <div className="metric-label">Urgency</div>
                  <div className="metric-value" style={{ fontSize: 14, color: URGENCY_COLORS[m.aeoDecision.stage3.urgencyLevel] || 'var(--text0)' }}>
                    {m.aeoDecision.stage3.urgencyLevel}
                  </div>
                  <div className="metric-sub" style={{ wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {m.aeoDecision.stage3.reason?.substring(0, 80)}
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
