// WGSL port of Sources/FilmEngine/Shaders.swift (film path) and the
// strength mix (ShaderLibrary.swift). Kernel for kernel, same maths, same
// order; comments mark where WGSL needs a different spelling. Plus two
// web-only kernels: decode_srgb (8-bit sRGB -> linear, what Core Image does
// on load) and encode_srgb (linear -> 8-bit sRGB, what Core Image does on save).

const COMMON = /* wgsl */ `
const kLuma = vec3f(0.2126, 0.7152, 0.0722);
const kGamutThreshold = 0.85;
`;

export const DECODE_SRGB = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
fn eotf(v: vec3f) -> vec3f {
  return select(pow((v + 0.055) / 1.055, vec3f(2.4)), v / 12.92, v <= vec3f(0.04045));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let c = textureLoad(src, gid.xy, 0).rgb;
  textureStore(dst, gid.xy, vec4f(eotf(c), 1.0));
}`;

export const ENCODE_SRGB = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
fn oetf(v: vec3f) -> vec3f {
  let c = clamp(v, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  textureStore(dst, gid.xy, vec4f(oetf(textureLoad(src, gid.xy, 0).rgb), 1.0));
}`;

export const INPUT_STAGE = COMMON + /* wgsl */ `
struct InputUniforms { gains: vec4f, params: vec4f, recovery: vec4f, e0: vec4f, e1: vec4f, e2: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u: InputUniforms;
@group(0) @binding(3) var linearClamp: sampler;

fn recoverHighlights(c: vec3f, k: f32, yw: f32) -> vec3f {
  let a = max(abs(c), vec3f(1e-10));
  let y = log(a / 0.18) / log(10.0);
  var x = select(k * y, k * y + ((1.0 - k) / yw) * y * y, y > vec3f(0.0));
  x = select(x, yw + (2.0 - k) * (y - yw), y > vec3f(yw));
  return sign(c) * 0.18 * pow(vec3f(10.0), x);
}
fn slog3ToLinear(x: f32) -> f32 {
  if (x >= 171.2102946929 / 1023.0) { return pow(10.0, (x * 1023.0 - 420.0) / 261.5) * (0.18 + 0.01) - 0.01; }
  return (x * 1023.0 - 95.0) * 0.01125000 / (171.2102946929 - 95.0);
}
fn sgamut3CineToRec709(c: vec3f) -> vec3f {
  return vec3f(dot(vec3f( 1.6269474097, -0.5401385389, -0.0868088708), c),
               dot(vec3f(-0.1785155271,  1.4179409274, -0.2394254004), c),
               dot(vec3f(-0.0444361150, -0.1959199662,  1.2403560812), c));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let isize = textureDimensions(dst);
  if (gid.x >= isize.x || gid.y >= isize.y) { return; }
  let size = vec2f(isize);
  let uv = (vec2f(gid.xy) + 0.5 + u.params.yz) / size;
  var c = textureSampleLevel(src, linearClamp, uv, 0.0).rgb;
  if (u.params.x > 0.5) { c = sgamut3CineToRec709(vec3f(slog3ToLinear(c.r), slog3ToLinear(c.g), slog3ToLinear(c.b))); }
  c *= u.gains.rgb;
  if (u.recovery.x > 0.5 && u.params.w != 1.0) { c = recoverHighlights(c, u.params.w, u.recovery.y); }
  else if (u.params.w != 1.0) { c = sign(c) * 0.18 * pow(abs(c) / 0.18, vec3f(u.params.w)); }
  if (u.e0.w > 0.5) { c = vec3f(dot(u.e0.xyz, c), dot(u.e1.xyz, c), dot(u.e2.xyz, c)); }
  if (u.recovery.z > 0.0) { c = min(c, vec3f(u.recovery.z)); }
  textureStore(dst, gid.xy, vec4f(c, 1.0));
}`;

export const DOWNSAMPLE2X = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let m = textureDimensions(src) - vec2u(1u);
  let s = gid.xy * 2u;
  let a = textureLoad(src, min(s, m), 0) + textureLoad(src, min(s + vec2u(1u, 0u), m), 0)
        + textureLoad(src, min(s + vec2u(0u, 1u), m), 0) + textureLoad(src, min(s + vec2u(1u, 1u), m), 0);
  textureStore(dst, gid.xy, a * 0.25);
}`;

export const BLUR_PASS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<uniform> params: vec4i; // x radius, y 0 horizontal / 1 vertical, z 1 = wrap
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dsize = textureDimensions(dst);
  if (gid.x >= dsize.x || gid.y >= dsize.y) { return; }
  let r = params.x;
  let dir = select(vec2i(1, 0), vec2i(0, 1), params.y != 0);
  let size = vec2i(textureDimensions(src));
  var acc = vec4f(0.0);
  for (var i = -r; i <= r; i++) {
    let q = vec2i(gid.xy) + dir * i;
    var p: vec2i;
    if (params.z != 0) { p = ((q % size) + size) % size; } else { p = clamp(q, vec2i(0), size - 1); }
    acc += weights[i + r] * textureLoad(src, p, 0);
  }
  textureStore(dst, gid.xy, acc);
}`;

const COMBINE_HEAD = /* wgsl */ `
struct CombineUniforms { weights: vec4f, params: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var b0: texture_2d<f32>;
@group(0) @binding(2) var b1: texture_2d<f32>;
@group(0) @binding(3) var b2: texture_2d<f32>;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> u: CombineUniforms;
@group(0) @binding(6) var linearClamp: sampler;
fn sampleBlurs(uv: vec2f, w: vec4f) -> vec3f {
  return w.x * textureSampleLevel(b0, linearClamp, uv, 0.0).rgb + w.y * textureSampleLevel(b1, linearClamp, uv, 0.0).rgb
       + w.z * textureSampleLevel(b2, linearClamp, uv, 0.0).rgb;
}`;

export const BLOOM_COMBINE = COMBINE_HEAD + /* wgsl */ `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let I = textureLoad(src, gid.xy, 0).rgb;
  let B = sampleBlurs(uv, u.weights);
  textureStore(dst, gid.xy, vec4f(mix(I, B, u.params.x), 1.0));
}`;

export const HALATION_COMBINE = COMBINE_HEAD + /* wgsl */ `
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let H = max(sampleBlurs(uv, u.weights), vec3f(0.0));
  textureStore(dst, gid.xy, vec4f(textureLoad(src, gid.xy, 0).rgb + u.params.rgb * H, 1.0));
}`;

export const HALATION_SOURCE = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> p: vec4f; // x threshold, y knee
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let I = textureLoad(src, gid.xy, 0).rgb;
  let x = max(max(max(I.r, I.g), I.b) - p.x, 0.0);
  let s = x * x / (x + p.y + 1e-6);
  textureStore(dst, gid.xy, vec4f(s, s, s, 1.0));
}`;

export const GRAIN_NOISE = /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> seed: vec4u;
fn pcg3d(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
fn unitOpen(h: u32) -> f32 { return (f32(h >> 8u) + 0.5) / 16777216.0; }
fn boxMuller(u1: f32, u2: f32) -> vec2f {
  let r = sqrt(-2.0 * log(u1));
  let t = 6.28318530718 * u2;
  return vec2f(r * cos(t), r * sin(t));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let h1 = pcg3d(vec3u(gid.x, gid.y, seed.x * 2u));
  let h2 = pcg3d(vec3u(gid.x, gid.y, seed.x * 2u + 1u));
  let g0 = boxMuller(unitOpen(h1.x), unitOpen(h1.y));
  let g1 = boxMuller(unitOpen(h1.z), unitOpen(h2.x));
  textureStore(dst, gid.xy, vec4f(g0, g1));
}`;

export const FILM_STAGE = COMMON + /* wgsl */ `
struct FilmUniforms {
  negGamma: vec4f, negToe: vec4f, negShoulder: vec4f, negSpeed: vec4f,
  negSoft: vec4f, negDmin: vec4f, negRange: vec4f,
  m0: vec4f, m1: vec4f, m2: vec4f,
  printGamma: vec4f, printShoulder: vec4f, printSoft: vec4f, lights: vec4f,
  grainAmount: vec4f, grainParams: vec4f, bwWeights: vec4f, tone: vec4f,
  finishA: vec4f, finishB: vec4f, mode: vec4f,
  splitShadow: vec4f, splitHighlight: vec4f, couplingCeiling: vec4f,
  negToeSoft3: vec4f, negShoulderSoft3: vec4f, printingScale: vec4f, couplingAnchor: vec4f,
  viewing: vec4f,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u: FilmUniforms;

fn log10v(x: vec3f) -> vec3f { return log(x) / log(10.0); }
fn softplus1(x: f32, a: f32) -> f32 {
  let z = x / a;
  return a * (max(z, 0.0) + log(1.0 + exp(-abs(z))));
}
fn filmCurve3(x: vec3f, toe: vec3f, sh: vec3f, g: vec3f, ts: vec3f, ss: vec3f) -> vec3f {
  let t = vec3f(softplus1(x.r - toe.r, ts.r), softplus1(x.g - toe.g, ts.g), softplus1(x.b - toe.b, ts.b));
  let s = vec3f(softplus1(x.r - sh.r, ss.r), softplus1(x.g - sh.g, ss.g), softplus1(x.b - sh.b, ss.b));
  return g * (t - s);
}
fn filmCurve(x: vec3f, toe: vec3f, sh: vec3f, g: vec3f, soft: vec2f) -> vec3f {
  let t = vec3f(softplus1(x.r - toe.r, soft.x), softplus1(x.g - toe.g, soft.x), softplus1(x.b - toe.b, soft.x));
  let s = vec3f(softplus1(x.r - sh.r, soft.y), softplus1(x.g - sh.g, soft.y), softplus1(x.b - sh.b, soft.y));
  return g * (t - s);
}
fn saturatedCoupling(raw: vec3f, coupled: vec3f, ceiling: vec4f) -> vec3f {
  let d = coupled - raw;
  let w = smoothstep(vec3f(0.0), vec3f(1.0), (ceiling.xyz - raw) / ceiling.w);
  return select(coupled, raw + d * w, d > vec3f(0.0));
}
fn couple(c: vec3f) -> vec3f { return vec3f(dot(u.m0.xyz, c), dot(u.m1.xyz, c), dot(u.m2.xyz, c)); }
fn viewRolloff(v: vec3f, g: f32, w: f32) -> vec3f {
  if (g <= 1.0) { return v; }
  let t = clamp((v - w) / (g - w), vec3f(0.0), vec3f(1.0));
  let r = w + (1.0 - w) * (1.0 - pow(1.0 - t, vec3f((g - w) / (1.0 - w))));
  return select(v, r, v > vec3f(w));
}
fn grainDensity(drel: vec3f, n: vec4f) -> vec3f {
  let rho = u.grainParams.z;
  let noise = (sqrt(rho) * n.w + sqrt(1.0 - rho) * n.xyz) * u.grainParams.y;
  let dnorm = clamp(drel / u.negRange.xyz, vec3f(0.0), vec3f(1.0));
  return u.grainAmount.xyz * (0.4 + 0.6 * sqrt(dnorm)) * noise;
}
fn toneBW(c: vec3f) -> vec3f {
  let v = c.g;
  let tc = u.tone.xyz / dot(u.tone.xyz, kLuma);
  let t = u.tone.w * (1.0 - sqrt(clamp(v, 0.0, 1.0)));
  return v * mix(vec3f(1.0), tc, t);
}
fn contrastAroundGrey(x: vec3f, k: f32) -> vec3f {
  let p = 0.18;
  let lo = p * pow(max(x, vec3f(0.0)) / p, vec3f(k));
  let hi = 1.0 - (1.0 - p) * pow(max(1.0 - x, vec3f(0.0)) / (1.0 - p), vec3f(k));
  return select(hi, lo, x < vec3f(p));
}
fn splitTone(c: vec3f) -> vec3f {
  let stops = log2(max(dot(c, kLuma), 1e-6) / 0.18);
  let ws = clamp(-stops / u.splitShadow.w, 0.0, 1.0);
  let wh = clamp(stops / u.splitHighlight.w, 0.0, 1.0);
  let sh = u.splitShadow.xyz / dot(u.splitShadow.xyz, kLuma);
  let hi = u.splitHighlight.xyz / dot(u.splitHighlight.xyz, kLuma);
  return c * mix(vec3f(1.0), sh, ws) * mix(vec3f(1.0), hi, wh);
}
fn gamutCompress(c: vec3f, t: f32) -> vec3f {
  let l = dot(c, kLuma);
  if (l <= 1e-6) { return max(c, vec3f(0.0)); }
  let ch = c - l;
  let room = select(vec3f(l), vec3f(max(1.0 - l, 1e-6)), ch > vec3f(0.0));
  let d = abs(ch) / room;
  let dist = max(max(d.r, d.g), d.b);
  if (dist <= t) { return c; }
  let x = (dist - t) / (1.0 - t);
  return l + ch * ((t + (1.0 - t) * x / (1.0 + x)) / dist);
}
fn finish(c0: vec3f, gid: vec2u, size: vec2f) -> vec3f {
  var c = contrastAroundGrey(c0, u.finishA.x);
  let l = dot(c, kLuma);
  c = l + u.finishA.y * (c - l);
  c = u.finishA.z + c * (u.finishA.w - u.finishA.z);
  let p = (vec2f(gid) + 0.5 - 0.5 * size) / size.x;
  let halfDiag = 0.5 * sqrt(1.0 + (size.y / size.x) * (size.y / size.x));
  let r = length(p) / halfDiag;
  return c * (1.0 - u.finishB.y * smoothstep(u.finishB.z, 1.25, r));
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let isize = textureDimensions(dst);
  if (gid.x >= isize.x || gid.y >= isize.y) { return; }
  let size = vec2f(isize);
  let lin = textureLoad(src, gid.xy, 0).rgb;
  var c = max(lin, vec3f(0.0));
  if (u.mode.y > 0.5) {
    let reversal = u.mode.x > 0.5 && u.mode.x < 1.5;
    let bw = u.mode.x > 1.5;
    var I = lin;
    if (bw) { I = vec3f(dot(lin, u.bwWeights.xyz)); }
    var logE = log10v(max(I, vec3f(1e-6)) / 0.18) + u.negSpeed.xyz;
    if (reversal) { logE += u.lights.xyz; }
    let raw = filmCurve3(logE, u.negToe.xyz, u.negShoulder.xyz, u.negGamma.xyz, u.negToeSoft3.xyz, u.negShoulderSoft3.xyz);
    let kk = max(u.printingScale.xyz, vec3f(1e-4));
    let matched = kk * raw;
    var dye = u.couplingAnchor.xyz + couple(matched - u.couplingAnchor.xyz);
    if (!bw) { dye = saturatedCoupling(matched, dye, u.couplingCeiling); }
    dye /= kk;
    var drel = select(dye, u.negRange.xyz - dye, reversal);
    if (u.grainParams.x > 0.5) { drel += grainDensity(drel, textureLoad(noiseTex, gid.xy, 0)); }
    if (reversal) {
      c = pow(vec3f(10.0), -drel);
    } else {
      let logEp = -u.printingScale.xyz * drel + u.lights.xyz;
      c = pow(vec3f(10.0), -filmCurve(logEp, vec3f(0.0), u.printShoulder.xyz, u.printGamma.xyz, u.printSoft.xy));
    }
    if (u.viewing.x > 0.5) { c = viewRolloff(u.viewing.y * c, u.viewing.y, u.viewing.z); }
    if (bw && u.tone.w > 0.0) { c = toneBW(c); }
    c = splitTone(c);
  }
  if (u.finishB.x > 0.5) { c = finish(c, gid.xy, size); }
  textureStore(dst, gid.xy, vec4f(gamutCompress(c, kGamutThreshold), 1.0));
}`;

export const STRENGTH_MIX = /* wgsl */ `
@group(0) @binding(0) var base: texture_2d<f32>;
@group(0) @binding(1) var look: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> t: vec4f;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  textureStore(dst, gid.xy, vec4f(mix(textureLoad(base, gid.xy, 0).rgb, textureLoad(look, gid.xy, 0).rgb, t.x), 1.0));
}`;

/// Full-screen blit for the on-screen canvas: linear texture -> sRGB-encoded canvas.
export const PRESENT = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn oetf(v: vec3f) -> vec3f {
  let c = clamp(v, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  return vec4f(oetf(textureSample(src, samp, i.uv).rgb), 1.0);
}`;

// PRESENT with a pure power encode instead of sRGB (video export: inverts the
// gamma 1.961 that Chrome's hardware video path linearises Rec.709 frames with).
export const PRESENT_POWER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> invGamma: vec4f;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let c = clamp(textureSample(src, samp, i.uv).rgb, vec3f(0.0), vec3f(1.0));
  return vec4f(pow(c, vec3f(invGamma.x)), 1.0);
}`;
