// Video export: decode -> film render -> H.264 encode -> MP4, frame by frame.
// Back-pressure: each frame waits for the encoder (`await source.add`), the decoder
// only runs a few frames ahead, and nothing holds the whole clip. Every VideoFrame
// and VideoSample is closed. A watchdog stops the export when no frame arrives for
// STALL_MS; Cancel goes through the same path.

import { MB, sampleToTexture, workingSize } from './clip.js';

export const STALL_MS = 15000;
/// Bits per pixel per frame for H.264, by quality. 1080p30 "standard" ≈ 9.3 Mbps.
export const QUALITY_BPP = { standard: 0.15, high: 0.25, maximum: 0.4 };
const AUDIO_BITRATE = 192e3;
/// Rendered frames are encoded with the inverse of the browser's decode (Rec.709, gamma
/// 1.961 in Chrome, the same curve as Core Image), so Strength 0 returns the source's code
/// values. The Mac app does the same since 19 Nov 2026; web and Mac exports agree within
/// about 1.5/255 (test V2).
// Codecs copied into MP4 untouched; anything else (PCM, for one) is re-encoded so
// common players can play the file.
const COPY_AUDIO = ['aac', 'mp3', 'opus', 'ac3', 'eac3', 'flac'];

/// H.264 bitrate for a size, frame rate and quality name.
export function videoBitrate(w, h, fps, quality) {
  const bpp = QUALITY_BPP[quality] ?? QUALITY_BPP.standard;
  return Math.round(Math.min(Math.max(w * h * Math.max(fps, 1) * bpp, 1e6), 160e6));
}

/// Rough output size in bytes, for the in-memory warning.
export function estimateBytes(clip, w, h, quality) {
  const v = videoBitrate(w, h, clip.info.frameRate, quality);
  return ((v + (clip.audio ? AUDIO_BITRATE : 0)) / 8) * clip.info.duration;
}

/// Raised for Cancel and for the stall watchdog; `.message` is shown as is.
export class ExportStopped extends Error {}

class Job {
  constructor() {
    this.lastFrameAt = performance.now();
    this.stopped = null;
    this.stopPromise = new Promise((_, reject) => { this.reject = reject; });
    this.stopPromise.catch(() => {});
  }

  stop(message) {
    if (this.stopped) return;
    this.stopped = new ExportStopped(message);
    this.reject(this.stopped);
  }

  /// Wait for `p` unless the job is stopped first.
  guard(p) { return Promise.race([p, this.stopPromise]); }
}

/// Export `clip` as MP4 to `target` (a Mediabunny target: StreamTarget or BufferTarget).
/// opts: { settings: LookSettings | null (null = original; grain reseeds per frame), maxDim,
///         quality, onProgress({ frames, total, fps }), controller }.
/// `controller.cancel()` is set here; calling it stops the export.
/// Resolves { frames, seconds, audio: 'copied <codec>' | 'encoded <codec>' | 'none' | reason }.
export async function exportClip(renderer, clip, target, opts) {
  const [w, h] = workingSize(clip.info, opts.maxDim ?? 0);
  const job = new Job();
  if (opts.controller) opts.controller.cancel = () => job.stop('Export cancelled.');
  const bitrate = videoBitrate(w, h, clip.info.frameRate, opts.quality);
  if (!(await MB.canEncodeVideo('avc', { width: w, height: h, bitrate }))) {
    throw new Error(`this browser cannot encode H.264 at ${w} × ${h}`);
  }
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: false }), target });
  const videoSource = new MB.VideoSampleSource({ codec: 'avc', quality: new MB.Quality({ bitrate }),
    keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(videoSource, { rotation: clip.info.rotation });
  const audioPlan = await planAudio(clip, output);
  const watchdog = setInterval(() => {
    if (performance.now() - job.lastFrameAt > STALL_MS) {
      job.stop(`Export stopped: no new frame for ${STALL_MS / 1000} s. The browser's decoder or encoder stalled.`);
    }
  }, 1000);
  const started = performance.now();
  try {
    await job.guard(output.start());
    const counts = await job.guard(Promise.all([
      encodeVideo(renderer, clip, videoSource, w, h, job, opts),
      audioPlan.run ? audioPlan.run(job) : Promise.resolve(),
    ]));
    await job.guard(output.finalize());
    return { frames: counts[0], seconds: (performance.now() - started) / 1000, audio: audioPlan.label, width: w, height: h };
  } catch (e) {
    job.stop(e.message);
    // Free encoders and the writer; do not wait forever on a stuck pipeline.
    await Promise.race([output.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    throw e;
  } finally {
    clearInterval(watchdog);
  }
}

async function encodeVideo(renderer, clip, source, w, h, job, opts) {
  const sink = new MB.VideoSampleSink(clip.video);
  const it = sink.samples();
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('webgpu');
  const total = clip.info.frameCount;
  const started = performance.now();
  let index = 0;
  try {
    for (;;) {
      const next = await job.guard(it.next());
      if (next.done) break;
      const sample = next.value;
      try {
        if (sample.timestamp < 0) continue; // before the composition starts: not presented
        await job.guard(renderFrame(renderer, sample, ctx, w, h, opts, index));
        const frame = new VideoFrame(canvas, { timestamp: sample.microsecondTimestamp,
          duration: sample.microsecondDuration });
        const out = new MB.VideoSample(frame);
        try {
          await job.guard(source.add(out));
        } finally {
          out.close();
          frame.close();
        }
      } finally {
        sample.close();
      }
      index++;
      job.lastFrameAt = performance.now();
      opts.onProgress?.({ frames: index, total, fps: index / ((performance.now() - started) / 1000) });
    }
  } finally {
    it.return().catch(() => {});
  }
  source.close();
  if (index === 0) throw new Error('the video track decoded to no frames');
  return index;
}

async function renderFrame(renderer, sample, ctx, w, h, opts, frameIndex) {
  const { texture: input, outputGamma } = await sampleToTexture(renderer, sample, w, h);
  const out = opts.settings ? renderer.render(input, opts.settings, { frameIndex }) : input;
  // Encode with the inverse of the browser's decode so Strength 0 keeps the source's code values.
  renderer.present(out, ctx, { gamma: outputGamma });
  if (out !== input) renderer.release(out);
  renderer.release(input);
}

/// Decide what happens to the first audio track. Further audio tracks are ignored.
async function planAudio(clip, output) {
  const track = clip.audio;
  if (!track) return { label: 'none' };
  const codec = await track.getCodec();
  const mp4Codecs = output.format.getSupportedAudioCodecs();
  if (codec && COPY_AUDIO.includes(codec) && mp4Codecs.includes(codec)) {
    const source = new MB.EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    return { label: `copied ${codec}`, run: (job) => copyAudio(track, source, job) };
  }
  if (!(await track.canDecode())) return { label: `left out: this browser cannot decode ${codec ?? 'this'} audio` };
  const channels = Math.min(await track.getNumberOfChannels(), 2);
  const inRate = await track.getSampleRate();
  const sampleRate = [44100, 48000].includes(inRate) ? inRate : 48000;
  const quality = new MB.Quality({ bitrate: AUDIO_BITRATE });
  let target = null;
  if (await MB.canEncodeAudio('aac', { numberOfChannels: channels, sampleRate, quality })) target = 'aac';
  else if (await MB.canEncodeAudio('opus', { numberOfChannels: channels, sampleRate: 48000, quality })) target = 'opus';
  if (!target) return { label: 'left out: this browser cannot encode AAC or Opus audio' };
  const source = new MB.AudioSampleSource({ codec: target, quality,
    transform: { numberOfChannels: channels, sampleRate: target === 'opus' ? 48000 : sampleRate } });
  output.addAudioTrack(source);
  return { label: `encoded ${codec ?? 'audio'} to ${target}`, run: (job) => encodeAudio(track, source, job) };
}

async function copyAudio(track, source, job) {
  const sink = new MB.EncodedPacketSink(track);
  const decoderConfig = await track.getDecoderConfig();
  const it = sink.packets();
  let first = true;
  try {
    for (;;) {
      const next = await job.guard(it.next());
      if (next.done) break;
      await job.guard(source.add(next.value, first ? { decoderConfig } : undefined));
      first = false;
    }
  } finally {
    it.return().catch(() => {});
  }
  source.close();
}

async function encodeAudio(track, source, job) {
  const sink = new MB.AudioSampleSink(track);
  const it = sink.samples();
  try {
    for (;;) {
      const next = await job.guard(it.next());
      if (next.done) break;
      const sample = next.value;
      try {
        if (sample.timestamp >= 0) await job.guard(source.add(sample));
      } finally {
        sample.close();
      }
    }
  } finally {
    it.return().catch(() => {});
  }
  source.close();
}
