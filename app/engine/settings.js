// Dotted setting keys (the Mac's `--set` keys, SettingsKeys.swift) onto a
// LookSettings object as stored in looks.json. Only the keys the web page and
// tests use; vector keys take one number (all channels) or [r, g, b].

const PATHS = {
  'input.exposure': ['input', 'exposureEV'],
  'input.temperature': ['input', 'temperature'],
  'input.tint': ['input', 'tint'],
  'film.enabled': ['film', 'enabled'],
  'film.coupling': ['film', 'coupling'],
  'print.cyan': ['print', 'cyan'],
  'print.magenta': ['print', 'magenta'],
  'print.yellow': ['print', 'yellow'],
  'print.brightness': ['print', 'brightness'],
  'halation.enabled': ['halation', 'enabled'],
  'halation.strength': ['halation', 'strength'],
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

export const cloneSettings = (s) => structuredClone(s);

/// `grain.format` takes a format name ("16mm") from `formats` (looks.json filmFormatsMM).
export function setKey(s, key, value, formats = null) {
  if (key === 'grain.format') {
    const mm = formats && typeof value === 'string' ? formats[value.toLowerCase()] : Number(value);
    if (!Number.isFinite(mm)) throw new Error(`unknown film format ${value}`);
    s.grain.formatWidthMM = mm;
    return;
  }
  const path = PATHS[key];
  if (!path) throw new Error(`unknown setting key ${key}`);
  s[path[0]][path[1]] = value;
}

export function getKey(s, key, formats = null) {
  if (key === 'grain.format') {
    const hit = formats && Object.entries(formats).find(([, mm]) => mm === s.grain.formatWidthMM);
    return hit ? hit[0] : String(s.grain.formatWidthMM);
  }
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
