// Opening a video file with Mediabunny: tracks, metadata, and decoded frames as
// renderer textures. No DOM here; the page (video/player.js) and the export
// (video/export.js) build on it. Everything stays in this tab.

import * as MB from '../vendor/mediabunny-1.66.1.min.mjs';

export { MB };

const HDR_TRANSFERS = new Set(['pq', 'hlg', 'smpte2084', 'arib-std-b67']);

/// A clip opened from a File: { input, video, audio, info }.
/// `info`: width/height (coded, before rotation), rotation, duration, firstTimestamp,
/// frameRate, frameCount (estimate from packets), hdr, codec, audioCodec, audioTracks.
export async function openClip(file) {
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('this file has no video track');
    if (!(await video.canDecode())) {
      const codec = (await video.getCodec()) ?? 'an unknown codec';
      throw new Error(`this browser cannot decode ${codec} video`);
    }
    const audioTracks = await input.getAudioTracks();
    const info = await readInfo(input, video, audioTracks);
    return { input, video, audio: audioTracks[0] ?? null, info };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

async function readInfo(input, video, audioTracks) {
  const colour = await video.getColorSpace();
  const hdr = (await video.hasHighDynamicRange()) || HDR_TRANSFERS.has(colour.transfer ?? '');
  const stats = await video.computePacketStats(); // reads packet metadata, not frames
  const firstTimestamp = await video.getFirstTimestamp();
  const end = await video.computeDuration();
  const rate = await video.computeFrameRateMetrics(); // from frame timestamps, not header metadata
  return {
    width: await video.getCodedWidth(),
    height: await video.getCodedHeight(),
    displayWidth: await video.getDisplayWidth(),
    displayHeight: await video.getDisplayHeight(),
    rotation: await video.getRotation(),
    firstTimestamp,
    duration: end - Math.min(0, firstTimestamp),
    frameRate: rate.bestGuessFrameRate || stats.averagePacketRate,
    frameCount: stats.packetCount,
    hdr,
    transfer: colour.transfer ?? null,
    codec: await video.getCodec(),
    audioCodec: audioTracks.length ? await audioTracks[0].getCodec() : null,
    audioTracks: audioTracks.length,
  };
}

/// Pixel size the renderer works at: coded size, long side capped at `maxDim`
/// (0 = original), both sides even (H.264 4:2:0 needs even sizes).
export function workingSize(info, maxDim) {
  const { width: w, height: h } = info;
  const k = maxDim > 0 ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  const even = (v) => Math.max(2, 2 * Math.round((v * k) / 2));
  return [even(w), even(h)];
}

/// Gamma that Chrome's hardware video path (macOS) linearises SDR frames with before
/// handing them over sRGB-encoded: Apple's Rec.709 curve. Measured, not documented:
/// a Rec.709 HEVC 10-bit and an H.264 clip both fit code^1.961 within 0.5/255, while
/// software-decoded (I420) frames arrive as their code values, untouched.
export const APPLE_709_GAMMA = 1.961;
const HARDWARE_FORMATS = new Set(['NV12', 'P010']);

/// Whether the browser colour-converted this frame with APPLE_709_GAMMA (hardware frames:
/// NV12/P010 or opaque, format null) or passed its code values through (software, I420…).
export function isGammaConverted(frame) {
  return frame.format === null || HARDWARE_FORMATS.has(frame.format);
}

/// VideoSample -> { texture (linear, [w, h]), outputGamma }. `outputGamma` is the power to
/// encode the rendered result with so that unchanged pixels keep their code values
/// (0 = sRGB, the inverse of the plain sRGB decode). Closes the VideoFrame made here,
/// not the sample.
export async function sampleToTexture(renderer, sample, w, h) {
  const frame = sample.toVideoFrame();
  try {
    const outputGamma = isGammaConverted(frame) ? APPLE_709_GAMMA : 0;
    if (frame.codedWidth === w && frame.codedHeight === h && !frame.rotation) {
      return { texture: renderer.importImage(frame, { highPrecision: true }), outputGamma };
    }
    const bitmap = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    try {
      return { texture: renderer.importImage(bitmap, { highPrecision: true }), outputGamma };
    } finally {
      bitmap.close();
    }
  } finally {
    frame.close();
  }
}

/// One sentence for HDR sources (shown on the page; the export is refused).
export const HDR_MESSAGE = 'This clip is HDR (HLG or PQ). The web version does not support HDR video yet, '
  + 'so it will not export it; use the Mac app for HDR clips.';
