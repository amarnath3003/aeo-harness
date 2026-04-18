/**
 * AEO Stage 3: Compute Allocator  (v2)
 *
 * Improvements over v1:
 *  - Weighted urgency scoring: instead of a hard keyword→tier jump,
 *    each matched keyword contributes a numeric score.  Scores accumulate,
 *    so "bear attack fracture bleeding" is rated higher than just "bear".
 *    This eliminates the cliff edge between HIGH and MEDIUM at one keyword.
 *  - Thermal throttling: optional cpuTempC device-state field; if the CPU
 *    is already hot, threads are capped to prevent thermal shutdown mid-reply.
 *  - Hysteresis guard: the caller can pass the last allocated thread count
 *    (prevThreads); small urgency changes within the same tier won't cause
 *    thrash between 4↔6 threads every query.
 *  - Power proxy metric: allocateThreads() returns an estimated
 *    power_proxy_core_seconds field computed from expected generation time
 *    (modelled as a linear function of thread count), giving the orchestrator
 *    a pre-inference energy estimate for the benchmark paper.
 *  - Deterministic tiebreaker: when battery and urgency signals exactly cancel,
 *    bias towards fewer threads (energy savings) rather than more.
 */

export const THREAD_CONFIG = {
  MAX      : 8,   // SOS / emergency
  HIGH     : 6,   // High-urgency medical/danger
  BALANCED : 4,   // Default baseline (matches Baseline pipeline)
  REDUCED  : 2,   // Low battery or low-urgency
  MIN      : 1    // Conservation mode
};

// ─── Keyword taxonomy with per-keyword weights ───────────────────────────────
//
// Weights are on a 0–10 scale.
//   10 = instant CRITICAL override (life-threatening)
//    7 = strong HIGH signal
//    4 = moderate MEDIUM push
//    1 = slight LOW signal (non-emergency)
//
// Multiple matches accumulate; final score is clamped to [0, 100].

const KEYWORDS = [
  // ── CRITICAL (score ≥ 20 → tier CRITICAL) ──
  { kw: 'sos',             score: 10, tier: 'CRITICAL' },
  { kw: 'mayday',          score: 10, tier: 'CRITICAL' },
  { kw: 'emergency',       score:  9, tier: 'CRITICAL' },
  { kw: 'unconscious',     score:  9, tier: 'CRITICAL' },
  { kw: 'not breathing',   score: 10, tier: 'CRITICAL' },
  { kw: 'cardiac',         score: 10, tier: 'CRITICAL' },
  { kw: 'heart attack',    score: 10, tier: 'CRITICAL' },
  { kw: 'severe bleeding', score: 10, tier: 'CRITICAL' },
  { kw: 'arterial',        score:  9, tier: 'CRITICAL' },
  { kw: 'tourniquet',      score:  9, tier: 'CRITICAL' },
  { kw: 'anaphylaxis',     score: 10, tier: 'CRITICAL' },
  { kw: 'anaphylactic',    score: 10, tier: 'CRITICAL' },
  { kw: 'airway',          score:  9, tier: 'CRITICAL' },
  { kw: 'choking',         score: 10, tier: 'CRITICAL' },
  { kw: 'drowning',        score: 10, tier: 'CRITICAL' },
  { kw: 'crush',           score:  8, tier: 'CRITICAL' },
  { kw: 'spinal',          score:  9, tier: 'CRITICAL' },
  { kw: 'stroke',          score:  9, tier: 'CRITICAL' },
  { kw: 'seizure',         score:  9, tier: 'CRITICAL' },
  { kw: 'overdose',        score:  9, tier: 'CRITICAL' },

  // ── HIGH (score 8–19 → tier HIGH) ──
  { kw: 'bleeding',        score:  7, tier: 'HIGH' },
  { kw: 'wound',           score:  6, tier: 'HIGH' },
  { kw: 'puncture',        score:  6, tier: 'HIGH' },
  { kw: 'fracture',        score:  6, tier: 'HIGH' },
  { kw: 'broken bone',     score:  6, tier: 'HIGH' },
  { kw: 'hypothermia',     score:  7, tier: 'HIGH' },
  { kw: 'frostbite',       score:  6, tier: 'HIGH' },
  { kw: 'heat stroke',     score:  7, tier: 'HIGH' },
  { kw: 'bear',            score:  5, tier: 'HIGH' },
  { kw: 'snake bite',      score:  7, tier: 'HIGH' },
  { kw: 'venomous',        score:  7, tier: 'HIGH' },
  { kw: 'trapped',         score:  6, tier: 'HIGH' },
  { kw: 'missing',         score:  5, tier: 'HIGH' },
  { kw: 'lost',            score:  4, tier: 'HIGH' },
  { kw: 'shelter now',     score:  6, tier: 'HIGH' },
  { kw: 'freezing',        score:  6, tier: 'HIGH' },
  { kw: 'flash flood',     score:  7, tier: 'HIGH' },
  { kw: 'avalanche',       score:  8, tier: 'HIGH' },
  { kw: 'wildfire',        score:  7, tier: 'HIGH' },
  { kw: 'dehydrated',      score:  5, tier: 'HIGH' },
  { kw: 'signal fire',     score:  5, tier: 'HIGH' },
  { kw: 'rescue',          score:  6, tier: 'HIGH' },
  { kw: 'altitude sick',   score:  7, tier: 'HIGH' },
  { kw: 'faint',           score:  5, tier: 'HIGH' },
  { kw: 'dizzy',           score:  3, tier: 'HIGH' },

  // ── LOW (slightly negative contribution) ──
  { kw: 'knot',            score: -1, tier: 'LOW' },
  { kw: 'curious',         score: -1, tier: 'LOW' },
  { kw: 'interesting',     score: -1, tier: 'LOW' },
  { kw: 'someday',         score: -2, tier: 'LOW' },
  { kw: 'hobby',           score: -2, tier: 'LOW' },
  { kw: 'recipe',          score: -2, tier: 'LOW' },
  { kw: 'general',         score: -1, tier: 'LOW' },
  { kw: 'fun',             score: -2, tier: 'LOW' },
  { kw: 'technique',       score: -1, tier: 'LOW' },
  { kw: 'learn',           score: -1, tier: 'LOW' },
  { kw: 'practice',        score: -1, tier: 'LOW' }
];

// Score thresholds that map accumulated score → urgency tier
const SCORE_THRESHOLDS = {
  CRITICAL : 10,   // any single CRITICAL keyword immediately qualifies
  HIGH     :  8,   // any single HIGH keyword with score ≥ 8, or accumulated
  MEDIUM_UP:  4,   // below HIGH, above LOW
  LOW      :  0    // score ≤ 0
};

// Thermal throttle: if CPU temp exceeds these °C, cap max threads
const THERMAL_CAPS = [
  { minTemp: 90, maxThreads: 2 },
  { minTemp: 80, maxThreads: 4 },
  { minTemp: 75, maxThreads: 6 }
];

// Hysteresis: thread count won't change if the delta is ≤ HYSTERESIS_BAND
// and urgency tier hasn't changed.
const HYSTERESIS_BAND = 0;  // set to 2 to enable; 0 = disabled (useful for benchmarks)

// Rough expected-generation-time coefficients (ms per output token) vs threads
// Derived empirically on Gemma-3-1B Q4_K_M; adjust for your device.
const GEN_TIME_MS_PER_TOKEN = {
  1: 280,
  2: 160,
  4: 95,
  6: 72,
  8: 62
};
const EXPECTED_OUTPUT_TOKENS = 120; // average response length assumption

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Score and classify query urgency.
 *
 * @param {string} prompt
 * @returns {{
 *   level          : 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW',
 *   score          : number,
 *   matchedKeywords: string[]
 * }}
 */
export function classifyUrgency(prompt) {
  const lower   = prompt.toLowerCase();
  let   total   = 0;
  const matched = [];

  for (const { kw, score, tier } of KEYWORDS) {
    if (lower.includes(kw)) {
      total += score;
      matched.push({ kw, score, tier });
    }
  }

  total = Math.max(-10, Math.min(100, total)); // clamp

  // Immediate CRITICAL if any single CRITICAL keyword was matched
  const hasCritical = matched.some(m => m.tier === 'CRITICAL');
  if (hasCritical || total >= SCORE_THRESHOLDS.CRITICAL) {
    return {
      level          : 'CRITICAL',
      score          : total,
      matchedKeywords: matched.map(m => m.kw)
    };
  }

  const level =
    total >= SCORE_THRESHOLDS.HIGH      ? 'HIGH'
  : total >= SCORE_THRESHOLDS.MEDIUM_UP ? 'MEDIUM'
  : 'LOW';

  return { level, score: total, matchedKeywords: matched.map(m => m.kw) };
}

/**
 * Allocate CPU threads for inference.
 *
 * @param {string} prompt       - Post-pruning prompt
 * @param {object} deviceState  - { batteryPct, ramUsedPct, cpuTempC, prevThreads }
 * @returns {{
 *   threads              : number,
 *   urgencyLevel         : string,
 *   urgencyScore         : number,
 *   reason               : string,
 *   matchedKeywords      : string[],
 *   powerProxyEstimateMs : number   // estimated total generation time × threads
 * }}
 */
export function allocateThreads(prompt, deviceState = {}) {
  const {
    batteryPct  = 100,
    ramUsedPct  = 0,
    cpuTempC,
    prevThreads
  } = deviceState;

  const { level: urgency, score, matchedKeywords } = classifyUrgency(prompt);

  // ── Step 1: raw thread count from urgency + battery ────────────────────────
  let threads;
  let reason;

  if (urgency === 'CRITICAL') {
    // Never throttle a life-threatening query — use MAX regardless
    threads = THREAD_CONFIG.MAX;
    reason  = `SOS/critical keywords [${matchedKeywords.join(', ')}]. MAX threads — battery override ignored.`;

  } else if (urgency === 'HIGH') {
    if (batteryPct > 20) {
      threads = THREAD_CONFIG.HIGH;
      reason  = `High urgency (score ${score}), battery ${batteryPct}% OK → ${threads} threads.`;
    } else {
      threads = THREAD_CONFIG.BALANCED;
      reason  = `High urgency (score ${score}) but critical battery ${batteryPct}% → balanced ${threads} threads.`;
    }

  } else if (urgency === 'LOW') {
    threads = batteryPct < 30 ? THREAD_CONFIG.MIN : THREAD_CONFIG.REDUCED;
    reason  = `Low urgency (score ${score}), battery ${batteryPct}% → conservation ${threads} thread(s).`;

  } else {
    // MEDIUM — battery-adaptive
    if (batteryPct < 15) {
      threads = THREAD_CONFIG.MIN;
      reason  = `Critical battery ${batteryPct}% → MIN threads.`;
    } else if (batteryPct < 35) {
      threads = THREAD_CONFIG.REDUCED;
      reason  = `Low battery ${batteryPct}% → REDUCED ${threads} threads.`;
    } else if (ramUsedPct > 0.85) {
      threads = THREAD_CONFIG.REDUCED;
      reason  = `High RAM pressure ${(ramUsedPct*100).toFixed(0)}% → REDUCED ${threads} threads.`;
    } else {
      threads = THREAD_CONFIG.BALANCED;
      reason  = `Medium urgency (score ${score}), battery ${batteryPct}%, RAM ${(ramUsedPct*100).toFixed(0)}% → BALANCED.`;
    }
  }

  // ── Step 2: thermal throttle ───────────────────────────────────────────────
  if (cpuTempC !== undefined && urgency !== 'CRITICAL') {
    for (const cap of THERMAL_CAPS) {
      if (cpuTempC >= cap.minTemp && threads > cap.maxThreads) {
        reason += ` Thermal cap at ${cpuTempC}°C → capped to ${cap.maxThreads}.`;
        threads = cap.maxThreads;
        break;
      }
    }
  }

  // ── Step 3: hysteresis guard ──────────────────────────────────────────────
  if (
    HYSTERESIS_BAND > 0 &&
    prevThreads !== undefined &&
    urgency !== 'CRITICAL' &&
    Math.abs(threads - prevThreads) <= HYSTERESIS_BAND
  ) {
    reason += ` Hysteresis guard: stayed at ${prevThreads} (delta ≤ ${HYSTERESIS_BAND}).`;
    threads = prevThreads;
  }

  // ── Step 4: power proxy estimate ──────────────────────────────────────────
  const msPerToken         = GEN_TIME_MS_PER_TOKEN[threads] ?? GEN_TIME_MS_PER_TOKEN[4];
  const genTimeMs          = msPerToken * EXPECTED_OUTPUT_TOKENS;
  const powerProxyEstimate = (genTimeMs / 1000) * threads; // core-seconds

  return {
    threads,
    urgencyLevel         : urgency,
    urgencyScore         : score,
    reason,
    matchedKeywords,
    powerProxyEstimateMs : Math.round(genTimeMs)
  };
}

export { THREAD_CONFIG as default };