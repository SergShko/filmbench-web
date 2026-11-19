// Dotted setting keys (the Mac's `--set` keys, SettingsKeys.swift) onto a
// LookSettings object as stored in looks.json. Only the keys the web page and
// tests use (Basic and Advanced controls).

const PATHS = {
  'input.exposure': ['input', 'exposureEV'],
  'input.temperature': ['input', 'temperature'],
  'input.tint': ['input', 'tint'],
  'film.enabled': ['film', 'enabled'],
  'film.process': ['film', 'process'],
  'film.coupling': ['film', 'coupling'],
  'film.midContrast': ['film', 'midContrast'],
  'bw.toneAmount': ['film', 'toneAmount'],
  'print.colorHeadEnabled': ['print', 'colorHeadEnabled'],
  'print.densityRange': ['print', 'densityRange'],
  'print.cyan': ['print', 'cyan'],
  'print.magenta': ['print', 'magenta'],
  'print.yellow': ['print', 'yellow'],
  'print.brightness': ['print', 'brightness'],
  'halation.enabled': ['halation', 'enabled'],
  'halation.strength': ['halation', 'strength'],
  'halation.threshold': ['halation', 'threshold'],
  'halation.knee': ['halation', 'knee'],
  'halation.radius': ['halation', 'radius'],
  'bloom.enabled': ['bloom', 'enabled'],
  'bloom.amount': ['bloom', 'amount'],
  'bloom.radius': ['bloom', 'radius'],
  'grain.enabled': ['grain', 'enabled'],
  'grain.amount': ['grain', 'amount'],
  'grain.size': ['grain', 'sizeMicrons'],
  'grain.formatWidthMM': ['grain', 'formatWidthMM'],
  'grain.seed': ['grain', 'seed'],
  'grain.fixedSeed': ['grain', 'fixedSeed'],
  'grain.chroma': ['grain', 'chroma'],
  'finish.enabled': ['finish', 'enabled'],
  'finish.contrast': ['finish', 'contrast'],
  'finish.saturation': ['finish', 'saturation'],
  'finish.blackPoint': ['finish', 'blackPoint'],
  'finish.whitePoint': ['finish', 'whitePoint'],
  'finish.vignette': ['finish', 'vignette'],
  'finish.vignetteRadius': ['finish', 'vignetteRadius'],
  'look.strength': ['look', 'strength'],
  'video.enabled': ['video', 'enabled'],
  'video.breath': ['video', 'breath'],
  'video.gateWeave': ['video', 'gateWeave'],
};

// Vector keys set one channel with a .r/.g/.b suffix (SettingsKeys.applyVector).
const VECTORS = {
  'print.shadowTint': ['print', 'shadowTint'],
  'print.highlightTint': ['print', 'highlightTint'],
};
const CHANNELS = { r: 0, g: 1, b: 2 };
// Negative softness: one value for all channels clears per-channel fits (the didSet
// of FilmCurve.toeSoftness / shoulderSoftness in LookSettings.swift).
const SOFTNESS = { 'neg.toeSoftness': 'toeSoftness', 'neg.shoulderSoftness': 'shoulderSoftness' };

function vectorPath(key) {
  const dot = key.lastIndexOf('.');
  const path = VECTORS[key.slice(0, dot)];
  const channel = CHANNELS[key.slice(dot + 1)];
  return path && channel !== undefined ? [...path, channel] : null;
}

export const cloneSettings = (s) => structuredClone(s);

/// `grain.format` takes a format name ("16mm") from `formats` (looks.json filmFormatsMM).
export function setKey(s, key, value, formats = null) {
  if (key === 'grain.format') {
    const mm = formats && typeof value === 'string' ? formats[value.toLowerCase()] : Number(value);
    if (!Number.isFinite(mm)) throw new Error(`unknown film format ${value}`);
    s.grain.formatWidthMM = mm;
    return;
  }
  if (SOFTNESS[key]) {
    s.film.curve[SOFTNESS[key]] = value;
    delete s.film.curve[`${SOFTNESS[key]}Channels`];
    return;
  }
  const vec = vectorPath(key);
  if (vec) { s[vec[0]][vec[1]][vec[2]] = value; return; }
  const path = PATHS[key];
  if (!path) throw new Error(`unknown setting key ${key}`);
  s[path[0]][path[1]] = value;
}

export function getKey(s, key, formats = null) {
  if (key === 'grain.format') {
    const hit = formats && Object.entries(formats).find(([, mm]) => mm === s.grain.formatWidthMM);
    return hit ? hit[0] : String(s.grain.formatWidthMM);
  }
  if (SOFTNESS[key]) return (s.film.curve[`${SOFTNESS[key]}Channels`] ?? [s.film.curve[SOFTNESS[key]]])[0];
  const vec = vectorPath(key);
  if (vec) return s[vec[0]][vec[1]][vec[2]];
  const path = PATHS[key];
  if (!path) throw new Error(`unknown setting key ${key}`);
  return s[path[0]][path[1]];
}

/// Apply {key: value} overrides to a copy.
export function withOverrides(s, overrides, formats = null) {
  const out = cloneSettings(s);
  for (const [k, v] of Object.entries(overrides)) setKey(out, k, v, formats);
  return out;
}
