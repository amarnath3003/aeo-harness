# Adaptive Edge Orchestrator (AEO) — Research benchmark harness

> A full-stack PoC (proof-of-concept) benchmark harness for the IEEE paper:
> **"The Adaptive Edge Orchestrator: Dynamic Hardware Resource Management for LLM Inference on Resource-Constrained Mobile Devices"**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Directory Structure](#3-directory-structure)
4. [Prerequisites](#4-prerequisites)
5. [Installation](#5-installation)
6. [Model Setup](#6-model-setup)
7. [Running the Harness](#7-running-the-harness)
8. [Using the UI](#8-using-the-ui)
9. [Running the Benchmark](#9-running-the-benchmark)
10. [Understanding the Output](#10-understanding-the-output)
11. [Configuration Reference](#11-configuration-reference)
12. [Customizing the AEO Stages](#12-customizing-the-aeo-stages)
13. [Adding Test Cases](#13-adding-test-cases)
14. [Extending the Charts](#14-extending-the-charts)
15. [API Reference](#15-api-reference)
16. [Mock Mode](#16-mock-mode)
17. [Troubleshooting](#17-troubleshooting)
18. [Research Notes](#18-research-notes)

---

## 1. Project Overview

This harness lets you empirically compare two inference pipelines side-by-side:

| Pipeline | Description |
|---|---|
| **Baseline** | Static 4-thread execution, raw context passed directly to `llama.cpp` |
| **AEO** | Full 3-stage middleware (Semantic Cache → Token Pruner → Compute Allocator) before `llama.cpp` |

The automated benchmark runner executes a predefined test corpus through **both** pipelines and records every metric the paper requires:

- `prompt_eval_time_sec` — how long the model spends processing the input
- `time_to_first_token_sec` — TTFT latency
- `generation_rate_tps` — tokens per second during generation
- `total_generation_time_sec` — end-to-end wall clock
- `power_proxy_core_seconds` — `total_time × thread_count` (battery proxy)
- `cache_hit` — whether Stage 1 served the response with zero compute
- `compression_ratio_pct` — how much the Token Pruner reduced the prompt
- RAM usage delta (MB) per run
- CPU temperature over time (real sensor or synthetic)

Results export to **CSV** and **JSON** for direct use in LaTeX tables or Python/R analysis.

---

## 2. Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────────────────────┐
│              AEO Orchestrator                   │
│                                                 │
│  Stage 1: Semantic Cache ──────► HIT → return   │
│              │ miss                             │
│              ▼                                  │
│  Stage 2: Token Pruner                          │
│     (200-word sensor dump → [HIGH_ALT][STORM])  │
│              │                                  │
│              ▼                                  │
│  Stage 3: Compute Allocator                     │
│     (urgency scan → assign N threads)           │
│              │                                  │
└──────────────┼──────────────────────────────────┘
               │
               ▼
       llama.cpp / node-llama-cpp
       gemma-3-1b-it-Q4_K_M.gguf
       (--threads N, dynamically set)
               │
               ▼
           Response + Metrics
```

### Stage 1 — Semantic Cache
A local in-memory `Map`. Uses **Jaccard similarity** over content-word token sets to match semantically equivalent queries. Similarity threshold: `0.55`. On a hit, the response is returned instantly with zero compute energy.

### Stage 2 — Token Pruner
Reads verbose sensor data (GPS floats, barometric decimals, etc.) and compresses it into compact semantic tags using rule tables:

| Raw Input | Output Tag |
|---|---|
| `altitude: 4127.3m` | `[EXTREME_ALT]` |
| `pressure: 962 hPa, falling 8 hPa/hr` | `[SEVERE_STORM_RISK]` |
| `temperature: -12°C` | `[SEVERE_COLD]` |
| `wind: 65 kph` | `[DANGEROUS_WIND]` |
| `battery: 18%` | `[LOW_BATTERY]` |

This reduces a 200-word (≈260 token) context to 4–8 tokens, lowering `prompt_eval_time_sec` and peak RAM.

### Stage 3 — Compute Allocator
Scans the prompt for urgency keywords and reads device state to assign CPU thread count:

| Condition | Threads |
|---|---|
| SOS / critical keywords | 8 (MAX) |
| High urgency + battery > 20% | 6 |
| Medium urgency, normal battery | 4 |
| Low urgency or battery < 35% | 2 |
| Critical battery (< 15%) | 1 (MIN) |

Thread count is passed directly to `node-llama-cpp`'s context creation and maps 1:1 to `llama.cpp`'s `--threads` flag.

---

## 3. Directory Structure

```
aeo-harness/
│
├── package.json              ← Root: concurrently dev script
├── start.sh                  ← One-command startup
├── .gitignore
├── scripts/
│   └── download-model.js     ← HuggingFace model downloader
│
├── backend/
│   ├── package.json
│   ├── .env.example          ← Copy to .env and configure
│   └── src/
│       ├── env.js            ← .env loader (imported first)
     ├── env.js            ← .env loader (imported first).
│       ├── server.js         ← Express server + all API routes
│       ├── llamaEngine.js    ← node-llama-cpp wrapper + mock mode
│       ├── aeo/
│       │   ├── semanticCache.js    ← Stage 1: Jaccard similarity cache
│       │   ├── tokenPruner.js      ← Stage 2: sensor data compression
│       │   ├── computeAllocator.js ← Stage 3: urgency-based thread alloc
│       │   └── orchestrator.js     ← Main pipeline chain (Stage 1→2→3)
│       ├── benchmark/
│       │   └── runner.js     ← Automated A/B test corpus + metrics
│       └── utils/
│           └── telemetry.js  ← Real CPU/RAM/temp sampling (systeminformation)
│
└── frontend/
    ├── package.json
    └── src/
        ├── index.js           ← React entry point
        ├── index.css          ← Dark terminal aesthetic, CSS vars
        ├── App.jsx            ← Root: topbar, tabs, live sensor strip
        ├── utils/
        │   └── api.js         ← Axios client + SSE stream helpers
        └── pages/
            ├── ChatPage.jsx      ← Interactive chat with AEO toggle
            ├── BenchmarkPage.jsx ← Automated runner + live results table
            └── ChartsPage.jsx    ← 8 Recharts graphs (power, TPS, RAM, thermal)
```

---

## 4. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 18.0 | LTS recommended. Verify your Node version with `node -v`. |
| npm | ≥ 9.0 | Comes with Node. |
| RAM | ≥ 4 GB | 2 GB for Q4_K_M model + OS overhead |
| Disk | ≥ 1.5 GB | For model file |
| OS | macOS / Linux / Windows (WSL2) | WSL2 strongly recommended on Windows |

You do **not** need Python, CUDA, or any Hugging Face tokens.

---

## 5. Installation

```bash
# Clone the repository
git clone <your-repo-url> aeo-harness
cd aeo-harness

# Install all dependencies (root + backend + frontend)
npm install
npm install --prefix backend
npm install --prefix frontend
```

> **Note on `node-llama-cpp`:** This package compiles `llama.cpp` from source using your system's C++ compiler during `npm install`. On macOS this uses `clang` (install Xcode CLI tools: `xcode-select --install`). On Ubuntu/Debian: `sudo apt install build-essential`. On Windows: use WSL2.

---

## 6. Model Setup

### Option A — Automatic download (recommended)

```bash
# Downloads gemma-3-1b-it-Q4_K_M.gguf (~800 MB) from HuggingFace
node scripts/download-model.js

# Or choose a different quantization:
node scripts/download-model.js --quant=Q8_0    # higher quality, ~1.5 GB
node scripts/download-model.js --quant=IQ3_M   # smaller, lower quality
```

The script handles redirects and shows download progress. The file is saved to `backend/models/`.

### Option B — Manual download

1. Go to: `https://huggingface.co/bartowski/gemma-3-1b-it-GGUF`
2. Download `gemma-3-1b-it-Q4_K_M.gguf`
3. Place it at: `backend/models/gemma-3-1b-it-Q4_K_M.gguf`

### Option C — Use a different model

Any GGUF model works. Just set `MODEL_PATH` in `backend/.env`:

```env
MODEL_PATH=./models/llama-3.2-1b-instruct-Q4_K_M.gguf
```

> **No model? No problem.** If the model file is missing, the harness runs in **Mock Mode** — it simulates realistic latencies scaled by thread count, so you can develop and test the UI/pipeline logic without a real inference engine. See [§16 Mock Mode](#16-mock-mode).

---

## 7. Running the Harness

### Recommended: one command

```bash
bash start.sh
```

This checks Node, detects the model, installs missing deps, copies `.env`, and starts both servers with color-coded output.

### Manual: two terminals

**Terminal 1 — Backend:**
```bash
cd backend
cp .env.example .env   # first time only
npm run dev            # or: npm start
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm start
```

### Using concurrently (from root):
```bash
npm run dev
```

Then open: **[http://localhost:3000](http://localhost:3000)**

Backend runs at `http://localhost:3001`. The React dev server proxies all `/api/*` requests to it automatically.

---

## 8. Using the UI

The interface has three tabs in the top navigation bar.

### Tab 1 — Chat

Use this for **interactive testing** and quick manual comparisons.

- **AEO Toggle** (top right): Flip between AEO pipeline and direct Baseline inference on any query.
- **Pipeline Visualization** (left sidebar): Watches Stage 1, 2, and 3 animate in real time as your query is processed. Green = hit/active, dimmed = bypassed.
- **Quick Prompts**: Pre-loaded test queries across all urgency levels. The "↺ Cache test" button sends the same query twice — watch Stage 1 turn green on the second hit.
- **Metrics panel** (right sidebar): Shows TTFT, TPS, power proxy (core·seconds), thread count, and the allocator's reasoning for each response.

**AEO ON vs OFF experiment:**
1. Ask any question with AEO ON → note the thread count and power proxy.
2. Toggle AEO OFF → ask the exact same question → compare the metrics.
3. The difference in `power_proxy_core_seconds` is your per-query energy saving.

### Tab 2 — Benchmark Runner

Use this for **automated A/B data collection** for your paper.

- Click **Run Full Benchmark** to execute all 9 test cases through both pipelines (18 total runs).
- Watch the results table populate live via SSE as each run completes.
- Color coding: Green left border = AEO rows, Blue = Baseline rows.
- Click **Export CSV** or **Export JSON** when complete.

The benchmark always starts with a **cold cache** (cache cleared before run) to ensure reproducible results.

### Tab 3 — Analytics

Charts auto-populate after a benchmark run. Eight charts:

1. **Power Proxy (core·seconds)** — grouped bar: AEO vs Baseline per test case
2. **Thread Allocation Distribution** — histogram of thread counts used
3. **Generation Rate (TPS)** — who generates faster?
4. **Time to First Token** — TTFT comparison per test
5. **Memory Profile** — live RAM usage over time, with pipeline transition markers
6. **Thermal Stability Profile** — CPU temperature over time (real sensor or synthetic)
7. **Battery Drain** — simulated battery % over session
8. **Thread vs Power Scatter** — correlation plot across all runs

---

## 9. Running the Benchmark

### Standard run

```bash
# In the UI: Benchmark Runner tab → "Run Full Benchmark"

# Or via API:
curl -X POST http://localhost:3001/api/benchmark/start
```

### Test corpus categories

| ID | Category | Query | AEO Expected |
|---|---|---|---|
| A1 | High-Urgency | SOS, deep puncture wound, thigh | 8 threads (MAX) |
| A2 | High-Urgency | Unconscious, not breathing | 8 threads (MAX) |
| B1 | Low-Urgency | How to tie a square knot | 1–2 threads (MIN) |
| B2 | Low-Urgency | Bow drill fire technique | 1–2 threads |
| C1 | Pruner Test | Camp vs push on? + 200-word GPS/baro dump | tokens pruned |
| C2 | Pruner Test | Storm risk? + 200-word sensor data | tokens pruned |
| D1 | Cache Run 1 | How to start a fire in wet conditions | cold cache miss |
| D2 | Cache Run 2 | How to start a fire in wet conditions | cache HIT |
| D3 | Cache Semantic | Best method to ignite fire when wood is wet | Jaccard hit |

Each test runs through **Baseline first**, then **AEO**, so the AEO cache is always populated from a real inference (D1), not a shortcut.

### Estimated runtime

| Mode | Per run | Full benchmark (18 runs) |
|---|---|---|
| Mock mode | ~1–8 seconds | ~3–5 minutes |
| Real model (Q4_K_M, 4-core laptop) | ~10–60 seconds | ~20–45 minutes |
| Real model (8-core desktop) | ~5–30 seconds | ~10–20 minutes |

---

## 10. Understanding the Output

### CSV column definitions

| Column | Type | Description |
|---|---|---|
| `test_id` | string | Test case identifier (A1, B1, D2...) |
| `category` | string | A/B/C/D |
| `pipeline_used` | string | `"Baseline"` or `"AEO"` |
| `thread_count` | int | CPU threads allocated for this run (0 = cache hit) |
| `prompt_eval_time_sec` | float | Time for model to process input tokens |
| `time_to_first_token_sec` | float | Wall-clock TTFT latency |
| `generation_rate_tps` | float | Tokens generated per second |
| `total_generation_time_sec` | float | End-to-end inference wall time |
| `power_proxy_core_seconds` | float | `total_time × thread_count` — battery proxy |
| `cache_hit` | bool | True if Stage 1 served response with 0 compute |
| `tokens_original` | int | Token count before AEO pruning |
| `tokens_pruned` | int | Token count after Stage 2 pruning |
| `compression_ratio_pct` | float | Percentage of tokens eliminated |
| `aeo_tags` | string | Semantic tags generated by Token Pruner |
| `urgency_level` | string | CRITICAL / HIGH / MEDIUM / LOW / N/A |
| `aeo_reason` | string | Allocator's human-readable decision rationale |
| `aeo_overhead_ms` | float | AEO pipeline processing overhead (ms) |
| `ram_before_mb` | float | System RAM used before inference (MB) |
| `ram_after_mb` | float | System RAM used after inference (MB) |
| `ram_delta_mb` | float | RAM increase during inference |
| `device_battery_pct` | float | Simulated device battery at time of run |
| `is_mock` | bool | True if model not loaded (mock mode) |

### Key metrics to extract for your paper

**Power saving (AEO vs Baseline):**
```python
import pandas as pd
df = pd.read_csv('aeo_benchmark_*.csv')
aeo = df[df['pipeline_used'] == 'AEO']
base = df[df['pipeline_used'] == 'Baseline']
print(f"Power saving: {((base['power_proxy_core_seconds'].mean() - aeo['power_proxy_core_seconds'].mean()) / base['power_proxy_core_seconds'].mean() * 100):.1f}%")
```

**Cache hit energy saving:**
```python
cache_hits = df[(df['pipeline_used'] == 'AEO') & (df['cache_hit'] == True)]
print(f"Zero-compute responses: {len(cache_hits)}")
print(f"Energy saved (proxy): {base['power_proxy_core_seconds'].mean() * len(cache_hits):.2f} core·seconds")
```

**Token compression:**
```python
pruner_tests = df[(df['pipeline_used'] == 'AEO') & (df['category'] == 'C')]
print(pruner_tests[['test_id', 'tokens_original', 'tokens_pruned', 'compression_ratio_pct']])
```

---

## 11. Configuration Reference

All configuration lives in `backend/.env`. Copy from `.env.example`:

```env
# Path to GGUF model file
MODEL_PATH=./models/gemma-3-1b-it-Q4_K_M.gguf

# GPU layer offload (0 = CPU-only for edge simulation)
GPU_LAYERS=0

# Backend port
PORT=3001

# llama.cpp context window (tokens)
CONTEXT_SIZE=2048

# Telemetry sampling rate
TELEMETRY_INTERVAL_MS=500
```

### Thread configuration (in `computeAllocator.js`)

```javascript
const THREAD_CONFIG = {
  MAX:      8,  // SOS / emergency — change to os.cpus().length for real hardware
  HIGH:     6,
  BALANCED: 4,  // matches Baseline static thread count
  REDUCED:  2,
  MIN:      1   // conservation mode
};
```

To match your actual test device, set `MAX` to the device's CPU core count.

### Urgency keyword taxonomy (in `computeAllocator.js`)

```javascript
const URGENCY_KEYWORDS = {
  CRITICAL: ['sos', 'mayday', 'unconscious', 'not breathing', ...],
  HIGH:     ['bleeding', 'wound', 'bear', 'snake bite', ...],
  LOW:      ['knot', 'tie', 'learn', 'basic', 'simple', ...]
};
```

Add any domain-specific survival keywords relevant to your scenario.

### Semantic cache threshold (in `semanticCache.js`)

```javascript
this.SIMILARITY_THRESHOLD = 0.55; // 0.0 = match anything, 1.0 = exact match only
```

Lower = more cache hits but potentially wrong answers. For conservative research, use `0.65`.

---

## 12. Customizing the AEO Stages

### Modifying Stage 2 — Token Pruner rules

Rules are defined as arrays in `backend/src/aeo/tokenPruner.js`. Each rule has a threshold and a tag:

```javascript
// Add a new humidity rule:
const HUMIDITY_RULES = [
  { min: 90, tag: '[EXTREME_HUMIDITY]' },
  { min: 70, tag: '[HIGH_HUMIDITY]' },
];

// Then in pruneSensorData(), add:
const humidity = explicitSensors.humidity ?? extractNumber(text, [/humidity[:\s]+([\d.]+)/]);
if (humidity !== null) {
  for (const rule of HUMIDITY_RULES) {
    if (humidity >= rule.min) { tags.add(rule.tag); break; }
  }
}
```

### Implementing Stage 4 — State Locker (KV cache)

The AEO paper describes pre-computing the KV cache for the static system prompt. In `node-llama-cpp` v3, this is done via `LlamaContextSequence`:

```javascript
// In llamaEngine.js, after creating context:
// Pre-fill KV cache with system prompt tokens
const systemTokens = await this.context.tokenize(SYSTEM_PROMPT);
await this.context.getSequence().evaluateWithoutGenerating(systemTokens);
// Now inference skips re-reading the system prompt on every call
```

### Implementing Stage 5 — Thermal Queue

Add to `llamaEngine.js` `infer()`:

```javascript
// Thermal throttle: inject sleep between tokens if temp > threshold
if (deviceTemp > 75) {
  const microSleepMs = (deviceTemp - 75) * 2; // 2ms per degree over threshold
  await new Promise(r => setTimeout(r, microSleepMs));
}
```

### Implementing Stage 6 — Model Router

Route to a smaller SLM for simple queries:

```javascript
// In orchestrator.js, before calling engine.infer():
const useSmallModel = aeoDecision.stage3.urgencyLevel === 'LOW'
  && !hasSensorContext;
const engineToUse = useSmallModel ? this.slmEngine : this.llmEngine;
```

---

## 13. Adding Test Cases

Open `backend/src/benchmark/runner.js` and add to the `TEST_CORPUS` array:

```javascript
{
  id: 'E1',                              // unique ID (shown in results table)
  category: 'E',                         // letter for grouping
  categoryLabel: 'Your-Category',
  query: 'Your test query here.',
  sensorContext: '',                      // '' = no sensor data
                                          // '__GENERATE__' = auto 200-word dump
  expectedAeoThreads: 4,                 // what you expect AEO to assign
  description: 'What this tests'
}
```

The runner automatically runs it through both pipelines and records all metrics. The charts update automatically when you re-run the benchmark.

---

## 14. Extending the Charts

Charts are in `frontend/src/pages/ChartsPage.jsx`. All use [Recharts](https://recharts.org/).

### Adding a new chart

1. Compute derived data from `results` array (already available in component scope)
2. Wrap in `<ChartCard title="Your Title">`:

```jsx
<ChartCard title="My New Metric">
  <ResponsiveContainer width="100%" height={220}>
    <LineChart data={myData}>
      <XAxis dataKey="test_id" />
      <YAxis />
      <Tooltip contentStyle={tooltipStyle} />
      <Line dataKey="myMetric" stroke="#34d399" dot={false} />
    </LineChart>
  </ResponsiveContainer>
</ChartCard>
```

3. Add it to the `charts-grid` div layout.

### Chart color reference

```javascript
const COLORS = {
  AEO:      '#34d399',  // green
  Baseline: '#60a5fa',  // blue
  temp:     '#f87171',  // red
  ram:      '#fbbf24',  // amber
  battery:  '#a78bfa',  // purple
};
```

---

## 15. API Reference

All endpoints are served by the Express backend at `http://localhost:3001`.

### `GET /api/status`
Returns engine and system state.
```json
{
  "modelLoaded": true,
  "modelPath": "./models/gemma-3-1b-it-Q4_K_M.gguf",
  "isMock": false,
  "cacheStats": { "entries": 3, "hits": 2, "misses": 4, "hitRate": "33.3" },
  "uptime": "142"
}
```

### `POST /api/infer`
Run a single inference. Body:
```json
{
  "query": "How do I treat a snakebite?",
  "sensorContext": "",
  "deviceState": { "batteryPct": 72, "ramUsedPct": 0.45 },
  "useAEO": true
}
```
Response includes `response`, `pipeline`, `cached`, `threads`, `aeoDecision`, `metrics`.

### `POST /api/benchmark/start`
Starts the automated benchmark. Returns immediately; stream results via SSE.

### `GET /api/benchmark/stream`
SSE stream. Events: `start`, `progress`, `result`, `complete`, `error`.

### `GET /api/benchmark/results`
Returns all results collected so far as a JSON array.

### `GET /api/benchmark/export/csv`
Downloads results as a `.csv` file (attachment).

### `GET /api/benchmark/export/json`
Downloads results as a `.json` file.

### `GET /api/telemetry/history?limit=200`
Returns last N telemetry samples (RAM, CPU temp, battery, threads).

### `GET /api/telemetry/stream`
SSE stream of live telemetry at configured interval (default 500ms).

### `GET /api/aeo/cache`
Returns cache statistics (entries, hits, misses, hit rate).

### `POST /api/aeo/cache/clear`
Clears the semantic cache. Called automatically before each benchmark run.

### `GET /api/aeo/log`
Returns the AEO pipeline audit log (last 500 entries).

---

## 16. Mock Mode

If `MODEL_PATH` does not exist or the GGUF fails to load, the harness automatically enters **Mock Mode**. A warning appears in the terminal and the UI shows a purple "Mock mode" badge.

In mock mode, the `LlamaEngine` simulates inference with realistic latency curves:

- **Thread scaling**: latency is divided by `min(threads, 6) / 4`, simulating real llama.cpp throughput scaling.
- **Prompt eval**: `200 + (800 / threads)` ms — faster with more threads, mimicking attention head parallelism.
- **Token generation**: `80ms / speedFactor` per token with ±20ms jitter.
- **Response content**: Keyword-matched survival answers.

This means all AEO stage logic, pipeline decisions, CSV exports, and charts work identically — only the response text and latencies are simulated. This is useful for:
- Developing the UI on a low-RAM machine
- Rapid iteration on AEO stage logic without inference overhead
- Demonstrating the harness when a GPU/model isn't available

---

## 17. Troubleshooting

### Backend crashes on startup: "No native build found"
`node-llama-cpp` needs to compile llama.cpp during `npm install`. Ensure you have:
- **macOS**: `xcode-select --install`
- **Ubuntu/Debian**: `sudo apt install build-essential cmake`
- **Windows**: Use WSL2 with the Ubuntu build tools above.

Then delete `backend/node_modules` and reinstall:
```bash
cd backend && rm -rf node_modules && npm install
```

### "Cannot find module ... llamaEngine"
Ensure you're running `npm run dev` from the `backend/` directory (not the root), or use `bash start.sh` from root.

### Model loads but generates garbage
You're using a quantization that's too aggressive for the prompt length. Switch to `Q4_K_M` or `Q8_0` via `.env`.

### UI shows "Backend offline"
The React frontend couldn't reach `localhost:3001`. Check:
1. Backend terminal shows no errors
2. `PORT=3001` in `backend/.env`
3. No firewall blocking localhost

### Charts show no data
Run the benchmark first (Benchmark Runner tab → Run Full Benchmark). Charts read from the same in-memory `benchmarkRunner` instance, so data is lost on backend restart. Export CSV before stopping.

### `systeminformation` returns 0 for CPU temperature
This is normal on many systems (requires root/admin access to thermal sensors, or sensors not exposed). The telemetry sampler falls back to a **synthetic thermal model** automatically — temperature is derived from `synth.thermalPct` which tracks active thread count and cooldown. This is accurate enough for relative comparisons.

### Cache similarity threshold too aggressive (wrong answers returned)
Increase the threshold in `semanticCache.js`:
```javascript
this.SIMILARITY_THRESHOLD = 0.70; // stricter matching
```

---

## 18. Research Notes

### Reproducing the A/B experiment

For publication-quality results:
1. Set a fixed `device battery` start value in `runner.js` (`batteryPct: 78`)
2. Run the benchmark **3 times** and average the metrics (re-run clears cache each time)
3. Note: Mock mode gives deterministic latencies; real model latencies vary ±5–15% run-to-run

### Power proxy interpretation

`power_proxy_core_seconds = total_generation_time_sec × thread_count`

This is a CPU utilization integral — more threads × more time = more energy. It's not a direct milliwatt measurement, but it's a **valid relative proxy** for battery drain on a fixed-frequency CPU. The paper should clarify this is a compute proxy, not a direct energy measurement.

For real energy measurement, add an INA219 current sensor or use Android's `BatteryManager.BATTERY_PROPERTY_CURRENT_NOW`.

### Thermal model limitations

The synthetic thermal model uses a linear heat accumulation rule:
```
temp = 35°C + (thermalPct × 55°C)
thermalPct increases by (threads/8 × 0.12) per AEO run
thermalPct increases by 0.18 per Baseline run
```

This is deliberately simple. For real thermal data, deploy on an Android device and read `/sys/class/thermal/thermal_zone*/temp`.

### Stage 4–6 are theoretical

Per the paper scope, Stages 4 (State Locker), 5 (Thermal Queue), and 6 (Model Router) are **not implemented** in this PoC. The benchmark only covers the Core Optimization Triad (Stages 1, 2, 3). The architecture code and placeholder comments are in place for future extension.

### Citation

If you use this harness in your paper, cite as:

```bibtex
@misc{aeo-harness-2025,
  title  = {Adaptive Edge Orchestrator: A Benchmark Harness for LLM Edge Inference},
  author = {[Your Name]},
  year   = {2025},
  note   = {Proof-of-Concept implementation for IEEE submission}
}
```

---

*Built for IEEE systems research. All AEO stage logic is in `backend/src/aeo/`. All metrics are in `backend/src/benchmark/runner.js`.*
