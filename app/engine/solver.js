// CPU side of the film path: a line-by-line port of FilmCurve.swift
// (FilmCurve, PrinterLightSolver), ToneModel.swift, GrainModel / GaussianKernel
// and UniformBuilder (Uniforms.swift). All maths in float64, as in Swift.
// `s` is a LookSettings object exactly as Swift's JSONEncoder writes it
// (web/looks.json): vectors are [r, g, b], absent optionals are undefined.

export const K = {
  middleGrey: 0.18,
  middleGreyDensity: -Math.log10(0.18),
  printerPointLog: 0.025,
  luma: [0.2126, 0.7152, 0.0722],
  displayWhite: 0.90,
  highlightRecoveryWhiteLog: Math.log10(0.90 / 0.18),
  viewingGainRange: [0.5, 40.0],
  viewingGainScanSteps: 80,
  viewingGainIterations: 40,
  halationReferenceWidthMM: 36.0,
  bloomScales: [1, 2, 4],
  bloomWeights: [0.5, 0.3, 0.2],
  halationScales: [1, 2.5, 6],
  halationWeights: [0.5, 0.3, 0.2],
  pyramidTargetSigmaPx: 3.0,
  kernelRadiusSigmas: 3.0,
  maxKernelRadius: 64,
  grainMinSigmaPx: 0.5,
  grainApertureVariance: 1.0 / 12.0,
  temperatureStops: 0.3,
  tintStops: 0.2,
  sceneToDisplayContrast: 1.45,
  midSlopeProbeStops: 0.05,
  splitToneShadowStops: 4.0,
  splitToneHighlightStops: 2.5,
  couplingCeilingStops: 1.0,
  couplingFadeSpan: 1.5,
  gamutCompressionThreshold: 0.85,
  solverIterations: 100,
  solverBracket: [-20, 20],
  filmFormatWidthMM: { '8mm': 4.8, '16mm': 10.26, '35mm': 36.0, '65mm': 52.48 },
};

const v3 = (x) => [x, x, x];
const add = (a, b) => a.map((x, i) => x + b[i]);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, b) => a.map((x, i) => x * b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => a.map((x) => x * k);

// ---- FilmCurve ---------------------------------------------------------------

export function softplus(x, a) {
  const z = x / a;
  return a * (Math.max(z, 0) + Math.log(1 + Math.exp(-Math.abs(z))));
}

export function curveValue(x, toe, shoulder, gamma, toeSoft, shoulderSoft) {
  return gamma * (softplus(x - toe, toeSoft) - softplus(x - shoulder, shoulderSoft));
}

export function curveInverse(target, toe, shoulder, gamma, toeSoft, shoulderSoft) {
  const f = (x) => curveValue(x, toe, shoulder, gamma, toeSoft, shoulderSoft);
  let [lo, hi] = K.solverBracket;
  if (!(f(lo) < target && f(hi) > target)) {
    throw new Error(`target density ${target} outside curve range ${f(lo)}...${f(hi)}`);
  }
  for (let i = 0; i < K.solverIterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export const toeSoft3 = (c) => c.toeSoftnessChannels ?? v3(c.toeSoftness);
export const shoulderSoft3 = (c) => c.shoulderSoftnessChannels ?? v3(c.shoulderSoftness);
export const curveRange = (c) => c.gamma.map((g, i) => g * (c.shoulder[i] - c.toe[i]));

function channelValue(curve, c, x) {
  return curveValue(x, curve.toe[c], curve.shoulder[c], curve.gamma[c], toeSoft3(curve)[c], shoulderSoft3(curve)[c]);
}

/// Rows sum to one; symmetric, so row/column order does not matter.
export function couplingMatrix(s) {
  const d = 1 + s, o = -s / 2;
  return [[d, o, o], [o, d, o], [o, o, d]];
}

const matVec = (m, v) => m.map((row) => dot(row, v));

function inverse3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function coupledDensity(raw, coupling, k, anchor) {
  const kk = k.map((x) => Math.max(x, 1e-4));
  const m = couplingMatrix(coupling);
  const dev = sub(mul(kk, raw), anchor);
  return add(anchor, matVec(m, dev)).map((x, i) => x / kk[i]);
}

// ---- PrinterLightSolver -------------------------------------------------------

const isBW = (s) => s.film.process === 'blackAndWhite';

export function effectiveCurve(s) {
  const c = s.film.curve;
  if (!isBW(s)) return c;
  const t3 = toeSoft3(c), s3 = shoulderSoft3(c);
  return {
    ...c,
    gamma: v3(c.gamma[0]), toe: v3(c.toe[0]), shoulder: v3(c.shoulder[0]),
    speed: v3(c.speed[0]), dmin: v3(c.dmin[0]),
    toeSoftnessChannels: v3(t3[0]), shoulderSoftnessChannels: v3(s3[0]),
  };
}

export const effectivePrintGamma = (s) => (isBW(s) ? v3(s.print.gamma[0]) : s.print.gamma);

export function printingScale(s) {
  const k = s.film.printingScaleChannels ?? [1, 1, 1];
  if (s.film.process === 'negativePrint') return k;
  if (s.film.process === 'blackAndWhite') return v3(k[0]);
  return [1, 1, 1];
}

export const usesViewing = (s) => !!s.film.viewingStageOn && s.film.enabled
  && (s.film.process === 'negativePrint' || s.film.process === 'reversal');

export function couplingAnchor(s, gain = 1) {
  if (s.film.process === 'reversal' && usesViewing(s)) {
    return curveRange(effectiveCurve(s)).map((r) => r - (K.middleGreyDensity + Math.log10(gain)));
  }
  if (!(s.film.process === 'negativePrint' || s.film.process === 'blackAndWhite')) return [0, 0, 0];
  const curve = effectiveCurve(s);
  const raw = [0, 1, 2].map((c) => channelValue(curve, c, curve.speed[c]));
  return mul(printingScale(s), raw);
}

function negativeLights(curve, gamma, s, coupling, printGrey) {
  const raw = [0, 1, 2].map((c) => channelValue(curve, c, curve.speed[c]));
  const coupled = coupledDensity(raw, coupling, printingScale(s), couplingAnchor(s));
  const greyDensity = mul(printingScale(s), coupled);
  return [0, 1, 2].map((c) => {
    const printShoulder = s.print.densityRange / gamma[c];
    const x = curveInverse(printGrey, 0, printShoulder, gamma[c], s.print.toeSoftness, s.print.shoulderSoftness);
    return x + greyDensity[c];
  });
}

function reversalLights(curve, coupling, greyDensity, viewed) {
  const target = curveRange(curve).map((r) => r - greyDensity);
  const pre = viewed ? target : matVec(inverse3(couplingMatrix(coupling)), target);
  const ts = toeSoft3(curve), ss = shoulderSoft3(curve);
  return [0, 1, 2].map((c) => curveInverse(pre[c], curve.toe[c], curve.shoulder[c], curve.gamma[c], ts[c], ss[c])
    - curve.speed[c]);
}

export function baseLightsForGain(s, gain) {
  const curve = effectiveCurve(s);
  const greyDensity = K.middleGreyDensity + Math.log10(gain);
  switch (s.film.process) {
    case 'reversal': return reversalLights(curve, s.film.coupling, greyDensity, usesViewing(s));
    case 'negativePrint': return negativeLights(curve, effectivePrintGamma(s), s, s.film.coupling, greyDensity);
    case 'blackAndWhite': return negativeLights(curve, effectivePrintGamma(s), s, 0, greyDensity);
    default: return [0, 0, 0];
  }
}

export function trims(s) {
  if (!s.print.colorHeadEnabled) return [0, 0, 0];
  const k = K.printerPointLog;
  const colour = isBW(s) ? [0, 0, 0] : [s.print.cyan, s.print.magenta, s.print.yellow];
  const bright = v3(s.print.brightness);
  if (s.film.process === 'reversal') return scale(sub(bright, colour), k);
  if (s.film.process === 'negativePrint' || isBW(s)) return scale(sub(colour, bright), k);
  return [0, 0, 0];
}

function viewedWhite(s, gain) {
  const lights = baseLightsForGain(s, gain);
  return dot(filmRGB(K.displayWhite, s, lights, gain), K.luma);
}

function tryViewedWhite(s, g) {
  try { return viewedWhite(s, g); } catch (e) {
    if (e instanceof Error && e.message.startsWith('target density')) return null; // Swift: `try?` skips this gain
    throw e;
  }
}

export function displayGain(s) {
  if (!usesViewing(s)) return 1;
  const target = K.displayWhite;
  const [glo, ghi] = K.viewingGainRange;
  const n = K.viewingGainScanSteps;
  let best = { g: 1.0, err: Infinity };
  let previous = null;
  for (let i = 0; i <= n; i++) {
    const g = glo * Math.pow(ghi / glo, i / n);
    const w = tryViewedWhite(s, g);
    if (w === null) { previous = null; continue; }
    if (Math.abs(w - target) < best.err) best = { g, err: Math.abs(w - target) };
    if (previous && (previous.w - target) * (w - target) <= 0) {
      return bisectGain(s, previous.g, g, w > previous.w);
    }
    previous = { g, w };
  }
  return best.g;
}

function bisectGain(s, lo, hi, rising) {
  for (let i = 0; i < K.viewingGainIterations; i++) {
    const mid = Math.sqrt(lo * hi);
    const below = viewedWhite(s, mid) < K.displayWhite;
    if (below === rising) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// ---- ToneModel ----------------------------------------------------------------

export function viewRolloff(v, g) {
  const w = K.displayWhite;
  if (!(g > 1 && v > w)) return v;
  const t = Math.min((v - w) / (g - w), 1);
  return w + (1 - w) * (1 - Math.pow(1 - t, (g - w) / (1 - w)));
}

export function filmRGB(e, s, lights, gain) {
  const curve = effectiveCurve(s);
  const bw = isBW(s);
  const wts = s.film.bwWeights;
  const input = bw ? e * (wts[0] + wts[1] + wts[2]) : e;
  let logE = add(v3(Math.log10(Math.max(input, 1e-6) / K.middleGrey)), curve.speed);
  if (s.film.process === 'reversal') logE = add(logE, lights);
  const raw = [0, 1, 2].map((c) => channelValue(curve, c, logE[c]));
  const dye = coupledDensity(raw, bw ? 0 : s.film.coupling, printingScale(s), couplingAnchor(s, gain));
  const range = curveRange(curve);
  let c;
  if (s.film.process === 'reversal') {
    c = [0, 1, 2].map((i) => Math.pow(10, -(range[i] - dye[i])));
  } else {
    const gamma = effectivePrintGamma(s);
    const k = printingScale(s);
    c = [0, 1, 2].map((i) => {
      const logEp = -k[i] * dye[i] + lights[i];
      const d = curveValue(logEp, 0, s.print.densityRange / gamma[i], gamma[i], s.print.toeSoftness, s.print.shoulderSoftness);
      return Math.pow(10, -d);
    });
  }
  if (!usesViewing(s)) return c;
  return c.map((x) => viewRolloff(gain * x, gain));
}

function neutralLuma(e, s, lights, gain) {
  let c = filmRGB(e, s, lights, gain);
  if (s.finish.enabled) c = c.map((x) => s.finish.blackPoint + x * (s.finish.whitePoint - s.finish.blackPoint));
  return dot(c, K.luma);
}

export function chainMidSlope(s) {
  const gain = displayGain(s);
  const lights = baseLightsForGain(s, gain);
  const h = K.midSlopeProbeStops, g = K.middleGrey;
  const up = neutralLuma(g * Math.pow(2, h), s, lights, gain);
  const down = neutralLuma(g * Math.pow(2, -h), s, lights, gain);
  return (Math.log2(up) - Math.log2(down)) / (2 * h);
}

/// `transferContrast`: rendering contrast already in the source (SourceTransfer.inputContrast:
/// 1.45 SDR, 1.2 HLG/PQ); S-Log3 is scene-referred (1.0) whatever the transfer.
export function exposurePower(s, transferContrast = K.sceneToDisplayContrast) {
  if (!s.film.enabled) return 1;
  const slope = chainMidSlope(s);
  if (!(slope > 1e-3 && Number.isFinite(slope))) throw new Error(`neutral mid slope ${slope} is not positive`);
  const inputContrast = s.input.profile === 'slog3' ? 1.0 : transferContrast;
  return s.film.midContrast * (K.sceneToDisplayContrast / inputContrast) / slope;
}

export const usesRecovery = (s, k) => !!s.film.highlightRecoveryOn && k < 2;

export function couplingCeiling(s, k, lights) {
  const curve = effectiveCurve(s);
  const e = Math.pow(2, K.couplingCeilingStops);
  let logE = add(v3(k * Math.log10(e / K.middleGrey)), curve.speed);
  if (s.film.process === 'reversal') logE = add(logE, lights);
  const raw = [0, 1, 2].map((c) => channelValue(curve, c, logE[c]));
  return mul(printingScale(s), raw);
}

// ---- Grain, kernels -------------------------------------------------------------

export function gaussianKernel(sigma) {
  const r = Math.min(K.maxKernelRadius, Math.max(1, Math.ceil(K.kernelRadiusSigmas * sigma)));
  const raw = [];
  for (let i = -r; i <= r; i++) raw.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = Float32Array.from(raw.map((x) => x / sum));
  let varianceGain = 0;
  for (const w of weights) varianceGain += w * w;
  return { weights, radius: r, varianceGain };
}

export function pyramidLevel(sigmaPx) {
  if (!(sigmaPx > K.pyramidTargetSigmaPx)) return 0;
  return Math.ceil(Math.log2(sigmaPx / K.pyramidTargetSigmaPx));
}

/// Residual Gaussian sigma at the pyramid level (BlurEncoder.blur).
export function residualSigma(sigmaPx, level) {
  const sc = Math.pow(2, level);
  const boxVariance = (sc * sc - 1) / 12;
  return Math.sqrt(Math.max(sigmaPx * sigmaPx - boxVariance, 0.25 * sc * sc)) / sc;
}

export function grainGeometry(g, imageWidth) {
  const fraction = (g.sizeMicrons / 1000) / Math.max(g.formatWidthMM, 0.1);
  const sigmaPx = fraction * imageWidth;
  const blurSigmaPx = Math.max(sigmaPx, K.grainMinSigmaPx);
  const apertureGain = sigmaPx / Math.sqrt(sigmaPx * sigmaPx + K.grainApertureVariance);
  return { sigmaPx, blurSigmaPx, apertureGain };
}

export function grainSeed(g, frameIndex) {
  const base = g.seed >>> 0;
  if (g.fixedSeed) return base;
  return (base + Math.imul(frameIndex >>> 0, 7919)) >>> 0;
}

export const gaugeScale = (s) => K.halationReferenceWidthMM / Math.max(s.grain.formatWidthMM, 0.1);

// ---- UniformBuilder ---------------------------------------------------------------

/// Deterministic per-frame pseudo-random number in [-1, 1) (FrameRandom.signed).
export function frameRandomSigned(frame, salt) {
  const M = (1n << 64n) - 1n;
  let x = (BigInt.asUintN(64, BigInt(frame)) * 0x9E3779B97F4A7C15n + BigInt(salt)) & M;
  x ^= x >> 30n; x = (x * 0xBF58476D1CE4E5B9n) & M;
  x ^= x >> 27n; x = (x * 0x94D049BB133111EBn) & M;
  x ^= x >> 31n;
  return Number(x >> 11n) / 2 ** 53 * 2 - 1;
}

export function inputGains(s, frameIndex) {
  const t = s.input.temperature * K.temperatureStops;
  const m = s.input.tint * K.tintStops;
  const raw = [Math.pow(2, t + m / 2), Math.pow(2, -m), Math.pow(2, -t + m / 2)];
  const wb = scale(raw, 1 / dot(raw, K.luma));
  let ev = s.input.exposureEV;
  if (s.video.enabled) ev += s.video.breath * frameRandomSigned(frameIndex, 11);
  return scale(wb, Math.pow(2, ev));
}

export function weave(s, frameIndex, width) {
  if (!(s.video.enabled && s.video.gateWeave > 0)) return [0, 0];
  const f = frameIndex;
  const amp = s.video.gateWeave * width;
  return [amp * (0.6 * Math.sin(f * 0.91) + 0.4 * Math.sin(f * 2.13 + 1.0)),
    amp * (0.6 * Math.sin(f * 0.57 + 2.0) + 0.4 * Math.sin(f * 1.71))];
}

export function exposureRows(s) {
  const m = s.film.exposureMatrix;
  if (!m || m.length !== 9 || s.film.process === 'digital' || isBW(s)) return [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  return [0, 1, 2].map((r) => [m[3 * r], m[3 * r + 1], m[3 * r + 2], r === 0 ? 1 : 0]);
}

/// Everything the GPU needs for one film render, solved once per settings change.
export function solveFilm(s, transferContrast = K.sceneToDisplayContrast) {
  const gain = displayGain(s);
  const lights = add(baseLightsForGain(s, gain), trims(s));
  const power = exposurePower(s, transferContrast);
  const ceiling = couplingCeiling(s, power, lights);
  return { gain, lights, power, ceiling };
}

/// FilmUniforms, field order as in the MSL/WGSL struct (27 vec4).
export function filmUniforms(s, solved, grainNorm, grainActive) {
  const { gain, lights, ceiling } = solved;
  const viewing = usesViewing(s);
  const curve = effectiveCurve(s);
  const bw = isBW(s);
  const printGamma = effectivePrintGamma(s);
  const m = couplingMatrix(bw ? 0 : s.film.coupling);
  const processCode = s.film.process === 'negativePrint' ? 0 : (s.film.process === 'reversal' ? 1 : 2);
  const grainScale = bw ? v3(s.grain.channelScale[0]) : s.grain.channelScale;
  const f4 = (v, w = 0) => [v[0], v[1], v[2], w];
  const rows = [
    f4(curve.gamma), f4(curve.toe), f4(curve.shoulder), f4(curve.speed),
    [curve.toeSoftness, curve.shoulderSoftness, 0, 0], f4(curve.dmin), f4(curveRange(curve)),
    f4(m[0]), f4(m[1]), f4(m[2]),
    f4(printGamma), f4(printGamma.map((g) => s.print.densityRange / g)),
    [s.print.toeSoftness, s.print.shoulderSoftness, 0, 0], f4(lights),
    f4(scale(grainScale, s.grain.amount)),
    [grainActive ? 1 : 0, grainNorm, bw ? 1 : Math.min(Math.max(s.grain.chroma, 0), 1), 0],
    f4(s.film.bwWeights), f4(s.film.toneColor, s.film.toneAmount),
    [s.finish.contrast, s.finish.saturation, s.finish.blackPoint, s.finish.whitePoint],
    [s.finish.enabled ? 1 : 0, s.finish.vignette, s.finish.vignetteRadius, 0],
    [processCode, s.film.enabled ? 1 : 0, 0, 0],
    f4(s.print.shadowTint, K.splitToneShadowStops), f4(s.print.highlightTint, K.splitToneHighlightStops),
    f4(ceiling, K.couplingFadeSpan),
    f4(toeSoft3(curve)), f4(shoulderSoft3(curve)), f4(printingScale(s)), f4(couplingAnchor(s, gain)),
    [viewing ? 1 : 0, gain, K.displayWhite, 0],
  ];
  return Float32Array.from(rows.flat());
}

/// InputUniforms (6 vec4). `sourceOnly`: the strength-mix "before" picture.
export function inputUniforms(s, solved, frameIndex, width, sourceOnly) {
  const slog = s.input.profile === 'slog3' ? 1 : 0;
  if (sourceOnly) return Float32Array.from([1, 1, 1, 0, slog, 0, 0, 1, 0, 0, 0, 0, ...new Array(12).fill(0)]);
  const g = inputGains(s, frameIndex);
  const w = weave(s, frameIndex, width);
  const rows = exposureRows(s);
  return Float32Array.from([
    g[0], g[1], g[2], 0,
    slog, w[0], w[1], solved.power,
    usesRecovery(s, solved.power) ? 1 : 0, K.highlightRecoveryWhiteLog, 0, 0,
    ...rows[0], ...rows[1], ...rows[2],
  ]);
}
