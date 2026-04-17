/**
 * AEO Stage 2: Token Pruner
 *
 * Compresses verbose sensor/context data into compact semantic tags
 * before the prompt reaches the inference engine.
 *
 * Purpose: Reduce prompt token count to lower RAM pressure and
 * prompt-eval latency (prompt_eval_time_sec metric).
 *
 * Example transformation:
 *   "GPS: 36.747832°N 118.291654°W, altitude: 4127.3m,
 *    barometric pressure: 612.7 hPa, pressure trend: falling 8.3 hPa/hr,
 *    temperature: -4.2°C, wind: 34 kph NW ..." (200 words)
 * →
 *   [HIGH_ALT][STORM_RISK][LOW_TEMP][STRONG_WIND] (4 tokens)
 */

// Sensor tag rule definitions
const ALTITUDE_RULES = [
  { min: 4000, tag: '[EXTREME_ALT]' },
  { min: 3000, tag: '[HIGH_ALT]' },
  { min: 1500, tag: '[MID_ALT]' },
  { min: 0,   tag: '[LOW_ALT]' }
];

const PRESSURE_RULES = [
  // Pressure below 1000 hPa AND falling = storm incoming
  { test: (p, trend) => p < 970,              tag: '[SEVERE_STORM_RISK]' },
  { test: (p, trend) => p < 1000 && trend < -3, tag: '[STORM_RISK]' },
  { test: (p, trend) => trend < -5,           tag: '[RAPID_PRESSURE_DROP]' },
  { test: (p, trend) => trend > 3,            tag: '[CLEARING_CONDITIONS]' }
];

const TEMP_RULES = [
  { max: -20, tag: '[EXTREME_COLD]' },
  { max: -5,  tag: '[SEVERE_COLD]' },
  { max: 5,   tag: '[LOW_TEMP]' },
  { max: 35,  tag: null },
  { max: 40,  tag: '[HIGH_TEMP]' },
  { max: Infinity, tag: '[EXTREME_HEAT]' }
];

const WIND_RULES = [
  { min: 60, tag: '[DANGEROUS_WIND]' },
  { min: 35, tag: '[STRONG_WIND]' },
  { min: 20, tag: '[MODERATE_WIND]' }
];

const BATTERY_RULES = [
  { max: 10, tag: '[CRIT_BATTERY]' },
  { max: 25, tag: '[LOW_BATTERY]' },
  { max: 50, tag: '[MED_BATTERY]' }
];

const RAM_RULES = [
  { min: 0.90, tag: '[CRIT_MEM_PRESSURE]' },
  { min: 0.75, tag: '[HIGH_MEM_PRESSURE]' },
  { min: 0.60, tag: '[MED_MEM_PRESSURE]' }
];

/**
 * Parse numeric value from sensor text using regex patterns
 */
function extractNumber(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/**
 * Main pruner function.
 *
 * @param {string} sensorText - Raw verbose sensor data string (could be 200+ words)
 * @param {object} explicitSensors - Optional: { altitude, pressure, pressureTrend, temp, wind, batteryPct, ramUsedPct }
 * @returns {{ prunedText: string, tags: string[], originalTokens: number, prunedTokens: number, compressionRatio: number }}
 */
export function pruneSensorData(sensorText, explicitSensors = {}) {
  const tags = new Set();
  const text = sensorText.toLowerCase();

  // --- Extract sensor values ---
  const altitude = explicitSensors.altitude ?? extractNumber(text, [
    /altitude[:\s]+(-?[\d.]+)\s*m/,
    /elev(?:ation)?[:\s]+(-?[\d.]+)\s*m/,
    /height[:\s]+(-?[\d.]+)\s*m/
  ]);

  const pressure = explicitSensors.pressure ?? extractNumber(text, [
    /pressure[:\s]+([\d.]+)\s*hpa/,
    /baro(?:metric)?[:\s]+([\d.]+)/,
    /([\d.]+)\s*hpa/
  ]);

  const pressureTrend = explicitSensors.pressureTrend ?? extractNumber(text, [
    /trend[:\s]+([+-]?[\d.]+)\s*hpa/,
    /([+-][\d.]+)\s*hpa\/hr/,
    /falling\s+([\d.]+)/
  ]) ?? (text.includes('falling') ? -4 : text.includes('rising') ? 3 : 0);

  const temp = explicitSensors.temp ?? extractNumber(text, [
    /temp(?:erature)?[:\s]+(-?[\d.]+)\s*°?c/,
    /(-?[\d.]+)\s*°c/,
    /(-?[\d.]+)\s*celsius/
  ]);

  const wind = explicitSensors.wind ?? extractNumber(text, [
    /wind[:\s]+([\d.]+)\s*kph/,
    /wind[:\s]+([\d.]+)\s*km\/h/,
    /([\d.]+)\s*kph/
  ]);

  const batteryPct = explicitSensors.batteryPct;
  const ramUsedPct = explicitSensors.ramUsedPct;

  // --- Apply rules ---
  if (altitude !== null) {
    for (const rule of ALTITUDE_RULES) {
      if (altitude >= rule.min) { tags.add(rule.tag); break; }
    }
  }

  if (pressure !== null) {
    for (const rule of PRESSURE_RULES) {
      if (rule.test(pressure, pressureTrend ?? 0)) tags.add(rule.tag);
    }
  }

  if (temp !== null) {
    for (const rule of TEMP_RULES) {
      if (temp <= rule.max) { if (rule.tag) tags.add(rule.tag); break; }
    }
  }

  if (wind !== null) {
    for (const rule of WIND_RULES) {
      if (wind >= rule.min) { tags.add(rule.tag); break; }
    }
  }

  if (batteryPct !== undefined) {
    for (const rule of BATTERY_RULES) {
      if (batteryPct <= rule.max) { tags.add(rule.tag); break; }
    }
  }

  if (ramUsedPct !== undefined) {
    for (const rule of RAM_RULES) {
      if (ramUsedPct >= rule.min) { tags.add(rule.tag); break; }
    }
  }

  // GPS coordinates: replace raw coords with [GPS_LOCKED] or [GPS_APPROX]
  const hasGPS = /\d{2,3}\.\d{4,}/.test(sensorText);
  if (hasGPS) tags.add('[GPS_LOCKED]');

  // Signal
  if (text.includes('no signal') || text.includes('signal: 0')) tags.add('[NO_SIGNAL]');

  const tagString = Array.from(tags).join('');
  const originalTokens = Math.ceil(sensorText.split(/\s+/).length * 1.3);
  const prunedTokens = Math.ceil(tagString.split(/\s+/).length * 1.3) + 2;

  return {
    prunedText: tagString || '[NOMINAL]',
    tags: Array.from(tags),
    originalTokens,
    prunedTokens,
    compressionRatio: originalTokens > 0
      ? ((originalTokens - prunedTokens) / originalTokens * 100).toFixed(1)
      : '0.0'
  };
}

/**
 * Generate a realistic 200-word synthetic sensor dump (for Category C tests)
 */
export function generateVerboseSensorData(overrides = {}) {
  const alt   = overrides.altitude ?? (3200 + Math.random() * 1500).toFixed(1);
  const lat   = (36.7 + Math.random() * 0.5).toFixed(6);
  const lon   = (118.2 + Math.random() * 0.8).toFixed(6);
  const pres  = overrides.pressure ?? (612 + Math.random() * 40).toFixed(1);
  const trend = overrides.trend ?? -(2 + Math.random() * 8).toFixed(1);
  const temp  = overrides.temp ?? (-3 + Math.random() * 10 - 5).toFixed(1);
  const wind  = overrides.wind ?? (28 + Math.random() * 30).toFixed(0);
  const hum   = (40 + Math.random() * 40).toFixed(0);
  const bat   = overrides.battery ?? (15 + Math.random() * 60).toFixed(0);

  return `
GPS Module Report: Primary fix acquired. Latitude: ${lat} degrees North. Longitude: ${lon} degrees West. Fix quality: 3D differential. Satellite count: 11 of 14 visible. HDOP: 0.87 (excellent). Current altitude above mean sea level: ${alt} meters. Altitude uncertainty: plus or minus 2.3 meters. Velocity over ground: 0.04 knots. Heading: 274.6 degrees true north.

Barometric Pressure Module: Current absolute pressure reading is ${pres} hPa. Sea-level corrected pressure: 1007.3 hPa. Three-hour pressure trend: falling at ${Math.abs(trend)} hPa per hour. Pressure tendency code: 6 (falling rapidly). Last calibration: 00:14:32 UTC. Temperature compensation applied: yes. Humidity: ${hum} percent relative. 

Thermistor Array: Ambient air temperature: ${temp} degrees Celsius. Wind chill equivalent: ${(parseFloat(temp) - 6).toFixed(1)} degrees Celsius. Sensor 1: ${temp} C. Sensor 2: ${(parseFloat(temp) + 0.3).toFixed(1)} C. Delta: 0.3 C (within tolerance).

Anemometer: Wind speed average: ${wind} kph. Peak gust: ${(parseFloat(wind) * 1.4).toFixed(0)} kph. Wind direction: 312 degrees (NW). Battery voltage: ${(parseInt(bat)/100 * 4.2 + 3.0).toFixed(2)}V. Battery state of charge: ${bat} percent. Estimated remaining runtime at current load: 3.4 hours.
  `.trim();
}
