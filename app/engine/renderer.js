// WebGPU film renderer: the port of FilmRenderer.swift + Blur.swift.
//
// API (used by the photo page; the video lane builds on it):
//   const r = await FilmRenderer.create();            // or new FilmRenderer(device)
//   const src = r.importImage(bitmapOrVideoFrame);    // -> linear rgba16float GPUTexture
//   const out = r.render(src, settings, { frameIndex }); // -> display-linear rgba16float GPUTexture
//   r.present(out, canvasContext);                    // draw to a canvas (sRGB-encoded)
//   r.present(out, ctx, { before: src, split: 0.5 }); // on-screen divider: src left of 50 %
//   const rgba = await r.readSRGB8(out);              // Uint8Array, 8-bit sRGB RGBA, row 0 at top
//   r.release(tex)                                    // return a texture to the pool
// `settings` is a LookSettings object as in looks.json. Textures from render() are
// owned by the caller until passed to release(). Everything is encoded into one
// command buffer per render, as on the Mac.

import * as S from './shaders.js';
import * as solver from './solver.js';

const TEX_FORMAT = 'rgba16float';
const WG = 16;

export class FilmRenderer {
  static async create() {
    if (!navigator.gpu) throw new Error('WebGPU is not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    return new FilmRenderer(device);
  }

  constructor(device) {
    this.device = device;
    this.maxTextureSize = device.limits.maxTextureDimension2D;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.pipelines = {};
    for (const [name, code] of Object.entries({
      decode: S.DECODE_SRGB, encode: S.ENCODE_SRGB, input: S.INPUT_STAGE, down: S.DOWNSAMPLE2X,
      blur: S.BLUR_PASS, bloom: S.BLOOM_COMBINE, halSrc: S.HALATION_SOURCE, halComb: S.HALATION_COMBINE,
      grain: S.GRAIN_NOISE, film: S.FILM_STAGE, mix: S.STRENGTH_MIX,
    })) {
      const module = device.createShaderModule({ code, label: name });
      this.pipelines[name] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: name });
    }
    this.pool = new Map();
    this.presentPipelines = new Map();
    this.solveCache = { key: null, value: null };
  }

  // ---- textures --------------------------------------------------------------

  acquire(w, h) {
    const key = `${w}x${h}`;
    const free = this.pool.get(key);
    if (free && free.length) return free.pop();
    return this.device.createTexture({
      size: [w, h], format: TEX_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
  }

  release(tex) {
    if (!tex) return;
    const key = `${tex.width}x${tex.height}`;
    if (!this.pool.has(key)) this.pool.set(key, []);
    this.pool.get(key).push(tex);
  }

  /// Drop every pooled texture (e.g. after the picture changes size).
  trimPool() {
    for (const list of this.pool.values()) list.forEach((t) => t.destroy());
    this.pool.clear();
  }

  /// ImageBitmap / VideoFrame / canvas (sRGB-encoded) -> linear rgba16float texture.
  /// `opts.highPrecision` copies through an rgba16float staging texture instead of
  /// rgba8unorm, keeping more than 8 bits from 10-bit video frames.
  importImage(source, opts = {}) {
    const w = source.displayWidth ?? source.width, h = source.displayHeight ?? source.height;
    if (w > this.maxTextureSize || h > this.maxTextureSize) {
      throw new Error(`picture ${w}×${h} exceeds this device's ${this.maxTextureSize} px texture limit`);
    }
    const raw = this.device.createTexture({ size: [w, h], format: opts.highPrecision ? 'rgba16float' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.device.queue.copyExternalImageToTexture({ source }, { texture: raw, premultipliedAlpha: false }, [w, h]);
    const out = this.acquire(w, h);
    const enc = this.device.createCommandEncoder();
    this._dispatch(enc, 'decode', [raw.createView(), out.createView()], w, h);
    this.device.queue.submit([enc.finish()]);
    raw.destroy();
    return out;
  }

  /// Linear rgba16float texture from interleaved linear float RGBA (tests, video lane).
  importLinear(data, w, h) {
    const out = this.acquire(w, h);
    const half = toHalf(data);
    this.device.queue.writeTexture({ texture: out }, half, { bytesPerRow: w * 8 }, [w, h]);
    return out;
  }

  // ---- plumbing -----------------------------------------------------------------

  _uniform(data) {
    const buf = this.device.createBuffer({ size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    this._transient.push(buf);
    return { buffer: buf };
  }

  _storage(data) {
    const buf = this.device.createBuffer({ size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buf, 0, data);
    this._transient.push(buf);
    return { buffer: buf };
  }

  _dispatch(enc, name, resources, w, h) {
    const pipeline = this.pipelines[name];
    const bind = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(w / WG), Math.ceil(h / WG));
    pass.end();
  }

  _new(w, h) {
    const t = this.acquire(w, h);
    this._temps.push(t);
    return t;
  }

  // ---- blurs (Blur.swift) ---------------------------------------------------------

  _blurContext(source) { return { levels: [source] }; }

  _pyramid(enc, ctx, level) {
    while (ctx.levels.length <= level) {
      const prev = ctx.levels[ctx.levels.length - 1];
      const next = this._new(Math.floor((prev.width + 1) / 2), Math.floor((prev.height + 1) / 2));
      this._dispatch(enc, 'down', [prev.createView(), next.createView()], next.width, next.height);
      ctx.levels.push(next);
    }
    return ctx.levels[level];
  }

  _blur(enc, ctx, sigmaPx) {
    const level = solver.pyramidLevel(sigmaPx);
    const src = this._pyramid(enc, ctx, level);
    return this._separable(enc, src, solver.gaussianKernel(solver.residualSigma(sigmaPx, level)), false);
  }

  _separable(enc, src, kernel, wrap) {
    const tmp = this._new(src.width, src.height);
    const out = this._new(src.width, src.height);
    const weights = this._storage(kernel.weights);
    for (const [a, b, vertical] of [[src, tmp, 0], [tmp, out, 1]]) {
      const params = this._uniform(Int32Array.from([kernel.radius, vertical, wrap ? 1 : 0, 0]));
      this._dispatch(enc, 'blur', [a.createView(), b.createView(), weights, params], b.width, b.height);
    }
    return out;
  }

  _combine(enc, kernel, src, blurs, weights, params) {
    const out = this._new(src.width, src.height);
    const u = this._uniform(Float32Array.from([...weights, 0, ...params]));
    this._dispatch(enc, kernel, [src.createView(), ...blurs.map((b) => b.createView()), out.createView(), u, this.sampler],
      out.width, out.height);
    return out;
  }

  // ---- stages (FilmRenderer.swift) ---------------------------------------------------

  _solve(s, transferContrast) {
    const key = JSON.stringify([s.film, s.print, s.input.profile, s.finish.enabled, s.finish.blackPoint,
      s.finish.whitePoint, transferContrast]);
    if (this.solveCache.key !== key) {
      this.solveCache = { key, value: solver.solveFilm(s, transferContrast) };
    }
    return this.solveCache.value;
  }

  _bloom(enc, src, b, gauge) {
    const ctx = this._blurContext(src);
    const sigma = b.radius * gauge * src.width;
    const blurs = solver.K.bloomScales.map((k) => this._blur(enc, ctx, sigma * k));
    return this._combine(enc, 'bloom', src, blurs, solver.K.bloomWeights, [b.amount, 0, 0, 0]);
  }

  _halation(enc, src, h, gauge) {
    const source = this._new(src.width, src.height);
    this._dispatch(enc, 'halSrc', [src.createView(), source.createView(),
      this._uniform(Float32Array.from([h.threshold, h.knee, 0, 0]))], src.width, src.height);
    const ctx = this._blurContext(source);
    const sigma = h.radius * gauge * src.width;
    const blurs = solver.K.halationScales.map((k) => this._blur(enc, ctx, sigma * k));
    return this._combine(enc, 'halComb', src, blurs, solver.K.halationWeights,
      [...h.tint.map((t) => t * h.strength), 0]);
  }

  _grain(enc, w, h, s, frameIndex) {
    if (!(s.grain.enabled && s.film.enabled)) return null;
    const raw = this._new(w, h);
    this._dispatch(enc, 'grain', [raw.createView(),
      this._uniform(Uint32Array.from([solver.grainSeed(s.grain, frameIndex), 0, 0, 0]))], w, h);
    const geometry = solver.grainGeometry(s.grain, w);
    const kernel = solver.gaussianKernel(geometry.blurSigmaPx);
    const blurred = this._separable(enc, raw, kernel, true);
    return { texture: blurred, normalisation: geometry.apertureGain / kernel.varianceGain };
  }

  /// One film render. `opts.frameIndex` (grain seed, video extras), `opts.transferContrast`
  /// (the source's rendering contrast: 1.45 SDR, default; 1.2 HLG/PQ). Returns a display-linear texture.
  render(input, s, opts = {}) {
    if (s.film.process === 'digital') throw new Error('digital looks are not ported to the web engine');
    const frameIndex = opts.frameIndex ?? 0;
    const solved = this._solve(s, opts.transferContrast ?? solver.K.sceneToDisplayContrast);
    const w = input.width, h = input.height;
    this._temps = [];
    this._transient = [];
    const enc = this.device.createCommandEncoder();
    const inputStage = this._new(w, h);
    this._dispatch(enc, 'input', [input.createView(), inputStage.createView(),
      this._uniform(solver.inputUniforms(s, solved, frameIndex, w, false)), this.sampler], w, h);
    let current = inputStage;
    const gauge = solver.gaugeScale(s);
    if (s.bloom.enabled) current = this._bloom(enc, current, s.bloom, gauge);
    if (s.halation.enabled && s.halation.strength !== 0) current = this._halation(enc, current, s.halation, gauge);
    const grain = this._grain(enc, w, h, s, frameIndex);
    const dummy = grain ? null : this._new(1, 1);
    let out = this.acquire(w, h);
    this._dispatch(enc, 'film', [current.createView(), (grain ? grain.texture : dummy).createView(), out.createView(),
      this._uniform(solver.filmUniforms(s, solved, grain ? grain.normalisation : 0, !!grain))], w, h);
    const strength = s.look.strength;
    if (strength !== 1) {
      const base = this._new(w, h);
      this._dispatch(enc, 'input', [input.createView(), base.createView(),
        this._uniform(solver.inputUniforms(s, solved, frameIndex, w, true)), this.sampler], w, h);
      const mixed = this.acquire(w, h);
      this._dispatch(enc, 'mix', [base.createView(), out.createView(), mixed.createView(),
        this._uniform(Float32Array.from([Math.min(Math.max(strength, 0), 1), 0, 0, 0]))], w, h);
      this._temps.push(out);
      out = mixed;
    }
    this.device.queue.submit([enc.finish()]);
    const transient = this._transient;
    this.device.queue.onSubmittedWorkDone().then(() => transient.forEach((b) => b.destroy()));
    this._temps.forEach((t) => this.release(t));
    this._temps = null;
    return out;
  }

  // ---- output ------------------------------------------------------------------------

  /// 8-bit sRGB RGBA bytes of a display-linear texture (what the Mac writes to a file).
  async readSRGB8(tex) {
    const w = tex.width, h = tex.height;
    const enc8 = this.device.createTexture({ size: [w, h], format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    this._dispatch(enc, 'encode', [tex.createView(), enc8.createView()], w, h);
    enc.copyTextureToBuffer({ texture: enc8 }, { buffer: buf, bytesPerRow }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
    buf.unmap();
    buf.destroy();
    enc8.destroy();
    return out;
  }

  /// Draw a display-linear texture into a canvas context (configured here), scaled to fit.
  /// `opts.gamma` > 0 encodes with a pure power 1/gamma instead of sRGB (video export).
  present(tex, context, opts = {}) {
    const format = navigator.gpu.getPreferredCanvasFormat();
    if (context.__filmFormat !== format) {
      context.configure({ device: this.device, format, alphaMode: 'opaque' });
      context.__filmFormat = format;
    }
    const power = opts.gamma > 0;
    const split = !power && opts.before && opts.split !== undefined;
    const key = `${format}${power ? ' power' : ''}${split ? ' split' : ''}`;
    if (!this.presentPipelines.has(key)) {
      const code = power ? S.PRESENT_POWER : (split ? S.PRESENT_SPLIT : S.PRESENT);
      const module = this.device.createShaderModule({ code });
      this.presentPipelines.set(key, this.device.createRenderPipeline({ layout: 'auto',
        vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } }));
    }
    const pipeline = this.presentPipelines.get(key);
    const entries = [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: this.sampler }];
    const uniform = power ? 1 / opts.gamma : (split ? opts.split : null);
    if (uniform !== null) {
      this._transient = [];
      entries.push({ binding: 2, resource: this._uniform(Float32Array.from([uniform, 0, 0, 0])) });
    }
    if (split) entries.push({ binding: 3, resource: opts.before.createView() });
    const bind = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    if (uniform !== null) {
      const transient = this._transient;
      this.device.queue.onSubmittedWorkDone().then(() => transient.forEach((buf) => buf.destroy()));
      this._transient = null;
    }
  }
}

/// float32 -> IEEE half bits (round to nearest even), for importLinear.
function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  const fv = new Float32Array(1), iv = new Uint32Array(fv.buffer);
  for (let i = 0; i < f32.length; i++) {
    fv[0] = f32[i];
    const x = iv[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    let m = x & 0x7fffff;
    if (e >= 31) { out[i] = sign | 0x7c00; continue; }
    if (e <= 0) {
      if (e < -10) { out[i] = sign; continue; }
      m |= 0x800000;
      const shift = 14 - e;
      let hm = m >>> shift;
      const rem = m & ((1 << shift) - 1), half = 1 << (shift - 1);
      if (rem > half || (rem === half && (hm & 1))) hm++;
      out[i] = sign | hm;
      continue;
    }
    let hm = m >>> 13;
    const rem = m & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (hm & 1))) { hm++; if (hm === 0x400) { hm = 0; e++; } }
    out[i] = e >= 31 ? (sign | 0x7c00) : (sign | (e << 10) | hm);
  }
  return out;
}
