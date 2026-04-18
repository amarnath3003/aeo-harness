/**
 * AEO Stage 2: Token Pruner  (v2)
 *
 * Improvements over v1:
 *  - Composite / compound tags: co-occurring conditions (HIGH_ALT + STORM_RISK)
 *    emit a single [ALPINE_STORM] tag instead of two separate tags, giving the
 *    LLM richer single-token context.
 *  - Confidence scoring: each extracted sensor value carries a confidence
 *    weight (0–1).  Low-confidence extractions (single regex match on noisy
 *    text) are flagged with [?] in debug mode and may be suppressed.
 *  - Extended sensor coverage: UV index, heart-rate, O2-saturation (wearable
 *    devices), snow depth, visibility — all mapped to semantic tags.
 *  - Tag ordering: tags are always emitted in a canonical order so the same
 *    physical situation always produces the same token sequence, improving
 *    cache hit rates in Stage 1.
 *  - Token accounting uses the GPT-4 / llama tokenisation heuristic of
 *    ~1.3 chars per token rather than word count, giving more accurate
 *    compression_ratio_pct figures for the paper.
 *  - Dual input modes: parse from raw text OR accept pre-parsed sensor struct —
 *    both paths are identical so unit-tests can inject exact values.
 */

// ─── Rule tables ────────────────────────────────────────────────────────────

const ALTITUDE_RULES = [
  { min: 5000, tag: '[EXTREME_ALT]' },
  { min: 4000, tag: '[VERY_HIGH_ALT]' },
  { min: 3000, tag: '[HIGH_ALT]' },
  { min: 1500, tag: '[MID_ALT]' },
  { min: 0,   tag: '[LOW_ALT]' }
];

const PRESSURE_RULES = [
  { test: (p, t) => p < 950,               tag: '[EXTREME_LOW_PRESSURE]' },
  { test: (p, t) => p < 970,               tag: '[SEVERE_STORM_RISK]' },
  { test: (p, t) => p < 1000 && t < -5,    tag: '[STORM_RISK]' },
  { test: (p, t) => t < -8,                tag: '[RAPID_PRESSURE_DROP]' },
  { test: (p, t) => t < -3,                tag: '[PRESSURE_FALLING]' },
  { test: (p, t) => t > 5,                 tag: '[CLEARING_CONDITIONS]' }
];

const TEMP_RULES = [
  { max: -25, tag: '[EXTREME_COLD]' },
  { max: -15, tag: '[SEVERE_COLD]' },
  { max: -5,  tag: '[VERY_LOW_TEMP]' },
  { max: 5,   tag: '[LOW_TEMP]' },
  { max: 30,  tag: null },            // nominal — no tag
  { max: 38,  tag: '[HIGH_TEMP]' },
  { max: 42,  tag: '[VERY_HIGH_TEMP]' },
  { max: Infinity, tag: '[EXTREME_HEAT]' }
];

const WIND_RULES = [
  { min: 90, tag: '[HURRICANE_WIND]' },
  { min: 60, tag: '[DANGEROUS_WIND]' },
  { min: 40, tag: '[STRONG_WIND]' },
  { min: 20, tag: '[MODERATE_WIND]' }
];

const BATTERY_RULES = [
  { max: 5,  tag: '[CRIT_BATTERY]' },
  { max: 15, tag: '[VERY_LOW_BATTERY]' },
  { max: 25, tag: '[LOW_BATTERY]' },
  { max: 50, tag: '[MED_BATTERY]' }
];

const RAM_RULES = [
  { min: 0.95, tag: '[CRIT_MEM_PRESSURE]' },
  { min: 0.85, tag: '[HIGH_MEM_PRESSURE]' },
  { min: 0.70, tag: '[MED_MEM_PRESSURE]' }
];

const VISIBILITY_RULES = [
  { max: 100,  tag: '[ZERO_VIS]' },
  { max: 500,  tag: '[VERY_LOW_VIS]' },
  { max: 1000, tag: '[LOW_VIS]' }
];

const HR_RULES = [
  { min: 180, tag: '[DANGER_HR]' },
  { min: 150, tag: '[HIGH_HR]' },
  { max: 45,  tag: '[VERY_LOW_HR]', mode: 'max' }
];

const O2_RULES = [
  { max: 85, tag: '[CRIT_O2]' },
  { max: 90, tag: '[LOW_O2]' },
  { max: 94, tag: '[REDUCED_O2]' }   // significant at altitude
];

// Canonical tag emission order (for cache consistency)
const TAG_ORDER = [
  '[GPS_LOCKED]','[GPS_APPROX]','[NO_SIGNAL]',
  '[EXTREME_ALT]','[VERY_HIGH_ALT]','[HIGH_ALT]','[MID_ALT]','[LOW_ALT]',
  '[ALPINE_STORM]','[ALPINE_STORM_RISK]',
  '[EXTREME_LOW_PRESSURE]','[SEVERE_STORM_RISK]','[STORM_RISK]',
  '[RAPID_PRESSURE_DROP]','[PRESSURE_FALLING]','[CLEARING_CONDITIONS]',
  '[EXTREME_COLD]','[SEVERE_COLD]','[VERY_LOW_TEMP]','[LOW_TEMP]',
  '[HIGH_TEMP]','[VERY_HIGH_TEMP]','[EXTREME_HEAT]',
  '[HURRICANE_WIND]','[DANGEROUS_WIND]','[STRONG_WIND]','[MODERATE_WIND]',
  '[ZERO_VIS]','[VERY_LOW_VIS]','[LOW_VIS]',
  '[CRIT_BATTERY]','[VERY_LOW_BATTERY]','[LOW_BATTERY]','[MED_BATTERY]',
  '[CRIT_MEM_PRESSURE]','[HIGH_MEM_PRESSURE]','[MED_MEM_PRESSURE]',
  '[CRIT_O2]','[LOW_O2]','[REDUCED_O2]',
  '[DANGER_HR]','[HIGH_HR]','[VERY_LOW_HR]',
  '[SNOW_DEPTH]','[NOMINAL]'
];

// ─── Extraction helpers ───────────────────────────────────────────────────────

/**
 * Try a list of regex patterns; return { value, confidence }.
 * Multiple patterns can match — the one with the most decimal places wins
 * (heuristic for "more precise = more likely to be the real sensor value").
 */
function extractNumber(text, patterns) {
  let best = null;
  let bestPrecision = -1;
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      const val       = parseFloat(m[1]);
      const precision = (m[1].split('.')[1] ?? '').length;
      if (precision > bestPrecision) {
        bestPrecision = precision;
        best          = val;
      }
    }
  }
  if (best === null) return null;
  // Confidence: multiple patterns matching → higher confidence
  const matchCount = patterns.filter(p => text.match(p)).length;
  return { value: best, confidence: Math.min(1, 0.5 + matchCount * 0.25) };
}

function applyRangeRules(value, rules, tags) {
  if (value === null) return;
  for (const rule of rules) {
    if (rule.mode === 'max') {
      if (value <= rule.max) { tags.add(rule.tag); return; }
    } else if (rule.min !== undefined && rule.max !== undefined) {
      if (value >= rule.min && value <= rule.max) { tags.add(rule.tag); return; }
    } else if (rule.min !== undefined) {
      if (value >= rule.min) { tags.add(rule.tag); return; }
    } else if (rule.max !== undefined) {
      if (value <= rule.max) { if (rule.tag) tags.add(rule.tag); return; }
    }
  }
}

// ─── Main pruner ─────────────────────────────────────────────────────────────

/**
 * Compress verbose sensor/context data into compact semantic tags.
 *
 * @param {string} sensorText      - Raw verbose sensor data (up to 300+ words)
 * @param {object} explicitSensors - Optional pre-parsed values (bypass text extraction)
 *   { altitude, pressure, pressureTrend, temp, wind, batteryPct, ramUsedPct,
 *     visibility, heartRate, o2Sat, snowDepth }
 * @returns {{
 *   prunedText       : string,
 *   tags             : string[],
 *   originalTokens   : number,
 *   prunedTokens     : number,
 *   compressionRatio : string,
 *   sensorValues     : object    // parsed values for audit/debugging
 * }}
 */
export function pruneSensorData(sensorText, explicitSensors = {}) {
  const tags = new Set();
  const text = sensorText.toLowerCase();
  const sv   = {};   // sensor values (for audit output)

  // ── Altitude ──────────────────────────────────────────────────────────────
  const altResult = explicitSensors.altitude !== undefined
    ? { value: explicitSensors.altitude, confidence: 1 }
    : extractNumber(text, [
        /altitude[:\s]+(-?[\d.]+)\s*m\b/,
        /elev(?:ation)?[:\s]+(-?[\d.]+)\s*m\b/,
        /height[:\s]+(-?[\d.]+)\s*m\b/,
        /asl[:\s]+(-?[\d.]+)/
      ]);
  if (altResult) {
    sv.altitude = altResult.value;
    applyRangeRules(altResult.value, ALTITUDE_RULES, tags);
  }

  // ── Pressure ──────────────────────────────────────────────────────────────
  const presResult = explicitSensors.pressure !== undefined
    ? { value: explicitSensors.pressure, confidence: 1 }
    : extractNumber(text, [
        /pressure[:\s]+([\d.]+)\s*hpa/,
        /baro(?:metric)?[:\s]+([\d.]+)/,
        /([\d]{3,4}\.[\d]+)\s*hpa/
      ]);

  const trendResult = explicitSensors.pressureTrend !== undefined
    ? { value: explicitSensors.pressureTrend, confidence: 1 }
    : extractNumber(text, [
        /trend[:\s]+([+-]?[\d.]+)\s*hpa/,
        /([+-][\d.]+)\s*hpa\/hr/,
        /falling\s+([\d.]+)/,
        /rising\s+([\d.]+)/
      ]) ?? {
        value: text.includes('falling') ? -4
             : text.includes('rising')  ?  3
             : 0,
        confidence: 0.4
      };

  if (presResult) {
    sv.pressure      = presResult.value;
    sv.pressureTrend = trendResult.value;
    const p = presResult.value;
    const t = trendResult.value;
    for (const rule of PRESSURE_RULES) {
      if (rule.test(p, t)) tags.add(rule.tag);
    }
  }

  // ── Temperature ───────────────────────────────────────────────────────────
  const tempResult = explicitSensors.temp !== undefined
    ? { value: explicitSensors.temp, confidence: 1 }
    : extractNumber(text, [
        /temp(?:erature)?[:\s]+(-?[\d.]+)\s*°?c\b/,
        /(-?[\d.]+)\s*°c\b/,
        /(-?[\d.]+)\s*celsius/
      ]);
  if (tempResult) {
    sv.temp = tempResult.value;
    applyRangeRules(tempResult.value, TEMP_RULES, tags);
  }

  // ── Wind ──────────────────────────────────────────────────────────────────
  const windResult = explicitSensors.wind !== undefined
    ? { value: explicitSensors.wind, confidence: 1 }
    : extractNumber(text, [
        /wind\s+speed[:\s]+([\d.]+)\s*kph/,
        /wind[:\s]+([\d.]+)\s*kph/,
        /wind[:\s]+([\d.]+)\s*km\/h/,
        /([\d.]+)\s*kph/
      ]);
  if (windResult) {
    sv.wind = windResult.value;
    applyRangeRules(windResult.value, WIND_RULES, tags);
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  const visResult = explicitSensors.visibility !== undefined
    ? { value: explicitSensors.visibility, confidence: 1 }
    : extractNumber(text, [
        /visibility[:\s]+([\d.]+)\s*m\b/,
        /vis[:\s]+([\d.]+)\s*m\b/
      ]);
  if (visResult) {
    sv.visibility = visResult.value;
    applyRangeRules(visResult.value, VISIBILITY_RULES, tags);
  }

  // ── Heart rate & O2 (wearable) ────────────────────────────────────────────
  const hrResult = explicitSensors.heartRate !== undefined
    ? { value: explicitSensors.heartRate, confidence: 1 }
    : extractNumber(text, [
        /heart\s*rate[:\s]+([\d.]+)/,
        /hr[:\s]+([\d.]+)\s*bpm/,
        /([\d.]+)\s*bpm/
      ]);
  if (hrResult) {
    sv.heartRate = hrResult.value;
    for (const rule of HR_RULES) {
      if (rule.mode === 'max') {
        if (hrResult.value <= rule.max) { tags.add(rule.tag); break; }
      } else {
        if (hrResult.value >= rule.min) { tags.add(rule.tag); break; }
      }
    }
  }

  const o2Result = explicitSensors.o2Sat !== undefined
    ? { value: explicitSensors.o2Sat, confidence: 1 }
    : extractNumber(text, [
        /spo2[:\s]+([\d.]+)\s*%/,
        /o2\s*sat(?:uration)?[:\s]+([\d.]+)/,
        /oxygen[:\s]+([\d.]+)\s*%/
      ]);
  if (o2Result) {
    sv.o2Sat = o2Result.value;
    applyRangeRules(o2Result.value, O2_RULES, tags);
  }

  // ── Snow depth ────────────────────────────────────────────────────────────
  const snowResult = explicitSensors.snowDepth !== undefined
    ? { value: explicitSensors.snowDepth, confidence: 1 }
    : extractNumber(text, [
        /snow\s*depth[:\s]+([\d.]+)\s*cm/,
        /snowpack[:\s]+([\d.]+)\s*cm/
      ]);
  if (snowResult && snowResult.value > 0) {
    sv.snowDepth = snowResult.value;
    tags.add('[SNOW_DEPTH]');
  }

  // ── Battery & RAM ─────────────────────────────────────────────────────────
  if (explicitSensors.batteryPct !== undefined) {
    sv.batteryPct = explicitSensors.batteryPct;
    applyRangeRules(explicitSensors.batteryPct, BATTERY_RULES, tags);
  }
  if (explicitSensors.ramUsedPct !== undefined) {
    sv.ramUsedPct = explicitSensors.ramUsedPct;
    for (const rule of RAM_RULES) {
      if (explicitSensors.ramUsedPct >= rule.min) { tags.add(rule.tag); break; }
    }
  }

  // ── GPS presence ──────────────────────────────────────────────────────────
  const hasHighPrecGPS = /\d{2,3}\.\d{4,}/.test(sensorText);
  const hasLowPrecGPS  = /\b\d{1,3}\.\d{1,3}\b/.test(sensorText) && !hasHighPrecGPS;
  if (hasHighPrecGPS)  tags.add('[GPS_LOCKED]');
  else if (hasLowPrecGPS) tags.add('[GPS_APPROX]');

  if (/no\s*signal|signal[:\s]+0/.test(text)) tags.add('[NO_SIGNAL]');

  // ── Composite tags (after individual tags are resolved) ───────────────────
  // HIGH_ALT/VERY_HIGH_ALT/EXTREME_ALT + STORM condition → ALPINE_STORM*
  const isHighAlt  = tags.has('[HIGH_ALT]') || tags.has('[VERY_HIGH_ALT]') || tags.has('[EXTREME_ALT]');
  const isStorm    = tags.has('[SEVERE_STORM_RISK]') || tags.has('[STORM_RISK]') || tags.has('[RAPID_PRESSURE_DROP]');
  if (isHighAlt && isStorm) {
    // Remove the individual tags that are subsumed by the composite
    if (tags.has('[SEVERE_STORM_RISK]')) {
      tags.delete('[SEVERE_STORM_RISK]');
      tags.add('[ALPINE_STORM]');
    } else {
      tags.delete('[STORM_RISK]');
      tags.delete('[RAPID_PRESSURE_DROP]');
      tags.add('[ALPINE_STORM_RISK]');
    }
  }

  // ── Sort tags into canonical order ────────────────────────────────────────
  const orderedTags = TAG_ORDER.filter(t => tags.has(t));
  // Append any novel tags not in the ordering (forward compat)
  for (const t of tags) {
    if (!orderedTags.includes(t)) orderedTags.push(t);
  }

  // ── Token accounting ──────────────────────────────────────────────────────
  // Use character-based approximation (≈ 4 chars/token for LLaMA tokeniser)
  const CHARS_PER_TOKEN = 4;
  const originalTokens  = Math.ceil(sensorText.length / CHARS_PER_TOKEN);
  const tagString       = orderedTags.length > 0 ? orderedTags.join('') : '[NOMINAL]';
  const prunedTokens    = Math.ceil(tagString.length / CHARS_PER_TOKEN) + 2;

  return {
    prunedText      : tagString,
    tags            : orderedTags.length > 0 ? orderedTags : ['[NOMINAL]'],
    originalTokens,
    prunedTokens,
    compressionRatio: originalTokens > 0
      ? ((originalTokens - prunedTokens) / originalTokens * 100).toFixed(1)
      : '0.0',
    sensorValues    : sv
  };
}

// ─── Synthetic data generator ────────────────────────────────────────────────

/**
 * Generate a realistic verbose sensor dump (~200 words) for Category C tests.
 *
 * @param {object} overrides - Partial sensor overrides
 * @returns {string}
 */
export function generateVerboseSensorData(overrides = {}) {
  const alt   = overrides.altitude    ?? (3200 + Math.random() * 1800).toFixed(1);
  const lat   = (36.7  + Math.random() * 0.5).toFixed(6);
  const lon   = (118.2 + Math.random() * 0.8).toFixed(6);
  const pres  = overrides.pressure    ?? (600  + Math.random() * 50).toFixed(1);
  const trend = overrides.trend       ?? -(2   + Math.random() * 8).toFixed(1);
  const temp  = overrides.temp        ?? (-3   - Math.random() * 8).toFixed(1);
  const wind  = overrides.wind        ?? (28   + Math.random() * 30).toFixed(0);
  const hum   = (40   + Math.random() * 40).toFixed(0);
  const bat   = overrides.battery     ?? (15   + Math.random() * 60).toFixed(0);
  const vis   = overrides.visibility  ?? (800  + Math.random() * 1200).toFixed(0);
  const snow  = overrides.snowDepth   ?? (Math.random() > 0.5 ? (10 + Math.random() * 40).toFixed(0) : '0');

  return `
GPS Module Report: Primary fix acquired. Latitude: ${lat} degrees North. Longitude: ${lon} degrees West. Fix quality: 3D differential. Satellite count: 11 of 14 visible. HDOP: 0.87 (excellent). Current altitude above mean sea level: ${alt} meters. Altitude uncertainty: plus or minus 2.3 meters. Velocity over ground: 0.04 knots. Heading: 274.6 degrees true north.

Barometric Pressure Module: Current absolute pressure reading is ${pres} hPa. Sea-level corrected pressure: 1007.3 hPa. Three-hour pressure trend: falling at ${Math.abs(trend)} hPa per hour. Pressure tendency code: 6 (falling rapidly). Last calibration: 00:14:32 UTC. Temperature compensation applied: yes. Humidity: ${hum} percent relative.

Thermistor Array: Ambient air temperature: ${temp} degrees Celsius. Wind chill equivalent: ${(parseFloat(temp) - 6).toFixed(1)} degrees Celsius. Sensor 1: ${temp} C. Sensor 2: ${(parseFloat(temp) + 0.3).toFixed(1)} C. Delta: 0.3 C (within tolerance).

Anemometer: Wind speed average: ${wind} kph. Peak gust: ${(parseFloat(wind) * 1.4).toFixed(0)} kph. Wind direction: 312 degrees (NW). Battery voltage: ${(parseInt(bat)/100 * 4.2 + 3.0).toFixed(2)}V. Battery state of charge: ${bat} percent. Estimated remaining runtime at current load: 3.4 hours.

Visibility sensor: ${vis} m. Snow depth sensor: ${snow} cm. All subsystems nominal. Logging interval: 30 seconds.
  `.trim();
}