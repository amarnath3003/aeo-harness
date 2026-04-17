/**
 * TelemetrySampler
 *
 * Continuously samples real system metrics at ~500ms intervals.
 * Used to build the memory profile and thermal stability graphs
 * shown in the research dashboard.
 *
 * Real metrics from systeminformation:
 *   - RAM used (MB)
 *   - CPU temperature (°C) — falls back to synthetic if not available
 *   - CPU load (%)
 *
 * Synthetic overlays (for mobile edge device simulation):
 *   - Battery % (drains over time based on compute load)
 *   - Thermal throttle events
 */

import si from 'systeminformation';
import { EventEmitter } from 'events';

export class TelemetrySampler extends EventEmitter {
  constructor() {
    super();
    this.samples = [];
    this.interval = null;
    this.startTime = null;
    this.isRunning = false;

    // Synthetic device state (simulates mobile hardware)
    this.synth = {
      batteryPct: 80,
      thermalPct: 0.3,   // 0-1, maps to simulated device temp
      throttleEvents: 0,
      activeThreads: 4,
      pipeline: 'idle'
    };
  }

  start(intervalMs = parseInt(process.env.TELEMETRY_INTERVAL_MS ?? '500')) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = Date.now();
    this.samples = [];

    this.interval = setInterval(() => this._sample(), intervalMs);
    console.log('[Telemetry] Sampler started');
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.isRunning = false;
    console.log('[Telemetry] Sampler stopped, samples:', this.samples.length);
  }

  /**
   * Update synthetic state when a benchmark run starts/ends.
   * Called by the benchmark runner.
   */
  notifyRunStart(pipeline, threads) {
    this.synth.pipeline = pipeline;
    this.synth.activeThreads = threads;
    // AEO throttled runs produce less heat
    const thermalIncrease = pipeline === 'AEO'
      ? (threads / 8) * 0.12
      : 0.18;
    this.synth.thermalPct = Math.min(1, this.synth.thermalPct + thermalIncrease);
  }

  notifyRunEnd(pipeline) {
    // Cool down
    this.synth.thermalPct = Math.max(0.2, this.synth.thermalPct - 0.05);
    // Battery drain proportional to threads used
    const drain = pipeline === 'AEO'
      ? (this.synth.activeThreads / 8) * 0.4
      : 0.6;
    this.synth.batteryPct = Math.max(5, this.synth.batteryPct - drain);
    this.synth.pipeline = 'idle';
  }

  async _sample() {
    const elapsed = (Date.now() - this.startTime) / 1000;

    let ramUsedMb = 0, cpuLoad = 0, cpuTempC = null;

    try {
      const [mem, load, temp] = await Promise.all([
        si.mem(),
        si.currentLoad(),
        si.cpuTemperature().catch(() => null)
      ]);
      ramUsedMb = parseFloat((mem.used / 1024 / 1024).toFixed(1));
      cpuLoad = parseFloat(load.currentLoad.toFixed(1));
      if (temp && temp.main && temp.main > 0) cpuTempC = parseFloat(temp.main.toFixed(1));
    } catch {}

    // Synthetic thermal model (for mobile simulation)
    const synthTempC = 35 + this.synth.thermalPct * 55; // 35°C idle → 90°C max
    const displayTemp = cpuTempC ?? parseFloat(synthTempC.toFixed(1));

    // Battery drift
    const idleDrain = 0.002;
    this.synth.batteryPct = Math.max(5, this.synth.batteryPct - idleDrain);

    // Thermal throttle detection
    if (displayTemp > 75) {
      this.synth.throttleEvents++;
    }

    // Gradual thermal cooldown
    this.synth.thermalPct = Math.max(0.15, this.synth.thermalPct - 0.008);

    const sample = {
      t: parseFloat(elapsed.toFixed(2)),
      timestamp: new Date().toISOString(),
      ram_used_mb: ramUsedMb,
      cpu_load_pct: cpuLoad,
      cpu_temp_c: displayTemp,
      battery_pct: parseFloat(this.synth.batteryPct.toFixed(1)),
      active_threads: this.synth.activeThreads,
      throttle_events: this.synth.throttleEvents,
      pipeline: this.synth.pipeline,
      is_synthetic_temp: cpuTempC === null
    };

    this.samples.push(sample);
    this.emit('sample', sample);
  }

  getSamples() { return this.samples; }

  getLatest() { return this.samples[this.samples.length - 1] || null; }

  // Separate samples by pipeline label for comparative charts
  getSamplesByPipeline() {
    return {
      aeo: this.samples.filter(s => s.pipeline === 'AEO'),
      baseline: this.samples.filter(s => s.pipeline === 'Baseline'),
      idle: this.samples.filter(s => s.pipeline === 'idle')
    };
  }
}
