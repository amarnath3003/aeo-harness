/**
 * AEO Stage 3: Compute Allocator
 *
 * Dynamically assigns CPU thread count to the llama.cpp inference call
 * based on a real-time matrix of:
 *   1. Query urgency (keyword scan)
 *   2. Device battery level
 *   3. RAM pressure
 *
 * In llama.cpp: thread count maps directly to --threads flag, which
 * controls how many cores are used for matrix multiplication.
 *
 * Higher threads = faster generation + higher power draw.
 * Lower threads  = slower generation + significant battery savings.
 */

const THREAD_CONFIG = {
  MAX:     8,   // SOS / emergency
  HIGH:    6,   // High-urgency medical/danger
  BALANCED: 4,  // Default baseline (matches Baseline pipeline)
  REDUCED:  2,  // Low battery or low-urgency
  MIN:      1   // Conservation mode
};

// Urgency keyword taxonomy — ordered by severity
const URGENCY_KEYWORDS = {
  CRITICAL: [
    'sos', 'mayday', 'emergency', 'unconscious', 'not breathing', 'cardiac',
    'heart attack', 'severe bleeding', 'arterial', 'tourniquet', 'anaphylaxis',
    'anaphylactic', 'airway', 'choking', 'drowning', 'crush', 'spinal'
  ],
  HIGH: [
    'bleeding', 'wound', 'puncture', 'fracture', 'broken bone', 'hypothermia',
    'frostbite', 'heat stroke', 'bear', 'snake bite', 'venomous', 'trapped',
    'missing', 'lost', 'shelter now', 'freezing', 'flash flood', 'avalanche',
    'wildfire', 'dehydrated severely', 'signal fire', 'rescue'
  ],
  LOW: [
    'knot', 'tie', 'learn', 'curious', 'interesting', 'fun', 'hobby',
    'someday', 'technique', 'recipe', 'basic', 'general', 'simple'
  ]
};

/**
 * Classify query urgency level from keyword scanning
 * @returns { level: 'CRITICAL'|'HIGH'|'MEDIUM'|'LOW', matchedKeywords: string[] }
 */
export function classifyUrgency(prompt) {
  const lower = prompt.toLowerCase();
  const matched = [];

  for (const kw of URGENCY_KEYWORDS.CRITICAL) {
    if (lower.includes(kw)) matched.push({ kw, level: 'CRITICAL' });
  }
  if (matched.length > 0) return { level: 'CRITICAL', matchedKeywords: matched.map(m => m.kw) };

  for (const kw of URGENCY_KEYWORDS.HIGH) {
    if (lower.includes(kw)) matched.push({ kw, level: 'HIGH' });
  }
  if (matched.length > 0) return { level: 'HIGH', matchedKeywords: matched.map(m => m.kw) };

  for (const kw of URGENCY_KEYWORDS.LOW) {
    if (lower.includes(kw)) matched.push({ kw, level: 'LOW' });
  }
  if (matched.length > 0) return { level: 'LOW', matchedKeywords: matched.map(m => m.kw) };

  return { level: 'MEDIUM', matchedKeywords: [] };
}

/**
 * Core allocation function.
 *
 * @param {string} prompt - The user prompt (post-pruning)
 * @param {object} deviceState - { batteryPct: number, ramUsedPct: number }
 * @returns {{ threads: number, urgencyLevel: string, reason: string, matchedKeywords: string[] }}
 */
export function allocateThreads(prompt, deviceState = {}) {
  const { batteryPct = 100, ramUsedPct = 0 } = deviceState;
  const { level: urgency, matchedKeywords } = classifyUrgency(prompt);

  // Critical battery override — never throttle a SOS
  if (urgency === 'CRITICAL') {
    return {
      threads: THREAD_CONFIG.MAX,
      urgencyLevel: urgency,
      reason: `SOS/critical keywords detected: [${matchedKeywords.join(', ')}]. Maximum threads regardless of battery.`,
      matchedKeywords
    };
  }

  // High urgency + battery ok
  if (urgency === 'HIGH' && batteryPct > 20) {
    return {
      threads: THREAD_CONFIG.HIGH,
      urgencyLevel: urgency,
      reason: `High-urgency query. Battery ${batteryPct}% sufficient. Allocating ${THREAD_CONFIG.HIGH} threads.`,
      matchedKeywords
    };
  }

  // High urgency but low battery
  if (urgency === 'HIGH' && batteryPct <= 20) {
    return {
      threads: THREAD_CONFIG.BALANCED,
      urgencyLevel: urgency,
      reason: `High-urgency but critical battery (${batteryPct}%). Balanced allocation to preserve device.`,
      matchedKeywords
    };
  }

  // Low urgency — conserve aggressively
  if (urgency === 'LOW') {
    const threads = batteryPct < 30 ? THREAD_CONFIG.MIN : THREAD_CONFIG.REDUCED;
    return {
      threads,
      urgencyLevel: urgency,
      reason: `Low-urgency query. Battery ${batteryPct}%. Conservation mode: ${threads} thread(s).`,
      matchedKeywords
    };
  }

  // MEDIUM urgency — battery-adaptive
  if (batteryPct < 15) {
    return {
      threads: THREAD_CONFIG.MIN,
      urgencyLevel: urgency,
      reason: `Critical battery (${batteryPct}%). Throttling to ${THREAD_CONFIG.MIN} thread regardless of urgency.`,
      matchedKeywords
    };
  }
  if (batteryPct < 35) {
    return {
      threads: THREAD_CONFIG.REDUCED,
      urgencyLevel: urgency,
      reason: `Low battery (${batteryPct}%). Reducing to ${THREAD_CONFIG.REDUCED} threads.`,
      matchedKeywords
    };
  }
  if (ramUsedPct > 0.85) {
    return {
      threads: THREAD_CONFIG.REDUCED,
      urgencyLevel: urgency,
      reason: `High RAM pressure (${(ramUsedPct*100).toFixed(0)}%). Reducing threads to prevent OOM.`,
      matchedKeywords
    };
  }

  return {
    threads: THREAD_CONFIG.BALANCED,
    urgencyLevel: urgency,
    reason: `Medium urgency. Battery ${batteryPct}%, RAM ${(ramUsedPct*100).toFixed(0)}%. Standard allocation.`,
    matchedKeywords
  };
}

export { THREAD_CONFIG };
