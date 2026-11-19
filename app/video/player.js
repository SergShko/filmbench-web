// Video preview: shows one decoded frame at a time through the film renderer, with
// play/pause and a scrubber. Playback drops frames rather than falling behind the
// clock; there is no audio in the preview.

import { MB, sampleToTexture, workingSize } from './clip.js';

const PREVIEW_MAX = 1920; // long side of the on-screen render

export class Player {
  /// hooks: { renderer, context (webgpu canvas context), settings() -> LookSettings | null,
  ///          onTime(seconds), onError(message) }
  constructor(clip, hooks) {
    this.clip = clip;
    this.hooks = hooks;
    this.sink = new MB.VideoSampleSink(clip.video);
    [this.w, this.h] = workingSize(clip.info, PREVIEW_MAX);
    this.texture = null;       // linear texture of the frame on screen
    this.time = clip.info.firstTimestamp;
    this.playing = false;
    this.seekTarget = null;    // latest scrubber request while a seek is running
    this.seeking = false;
  }

  get start() { return this.clip.info.firstTimestamp; }
  get end() { return this.start + this.clip.info.duration; }

  frameIndexAt(t) { return Math.max(0, Math.round((t - this.start) * this.clip.info.frameRate)); }

  /// Re-render the frame on screen (after a settings change).
  redraw() {
    if (!this.texture) return;
    const r = this.hooks.renderer;
    const s = this.hooks.settings();
    try {
      const out = s ? r.render(this.texture, s, { frameIndex: this.frameIndexAt(this.time) }) : this.texture;
      r.present(out, this.hooks.context);
      if (out !== this.texture) r.release(out);
    } catch (e) {
      this.hooks.onError(`Could not render this look: ${e.message}`);
    }
  }

  async _show(sample) {
    const { texture: tex } = await sampleToTexture(this.hooks.renderer, sample, this.w, this.h);
    if (this.texture) this.hooks.renderer.release(this.texture);
    this.texture = tex;
    this.time = sample.timestamp;
    this.redraw();
    this.hooks.onTime(this.time);
  }

  /// Show the frame at `t` seconds. Rapid calls (scrubbing) coalesce to the latest.
  async seek(t) {
    this.seekTarget = Math.min(Math.max(t, this.start), this.end);
    if (this.seeking) return;
    this.seeking = true;
    try {
      while (this.seekTarget !== null) {
        const target = this.seekTarget;
        this.seekTarget = null;
        const sample = await this.sink.getSample(target);
        if (!sample) continue;
        try { await this._show(sample); } finally { sample.close(); }
      }
    } catch (e) {
      this.hooks.onError(`Could not show this frame: ${e.message}`);
    } finally {
      this.seeking = false;
    }
  }

  async play() {
    if (this.playing) return;
    this.playing = true;
    let from = this.time;
    if (from >= this.end - 1e-3) from = this.start;
    const it = this.sink.samples(from);
    const clockStart = performance.now() / 1000 - (from - this.start);
    try {
      for (;;) {
        if (!this.playing) break;
        const next = await it.next();
        if (next.done) break;
        const sample = next.value;
        try {
          const due = clockStart + (sample.timestamp - this.start);
          const now = performance.now() / 1000;
          if (due + sample.duration < now) continue; // late: drop it
          if (due > now) await new Promise((r) => setTimeout(r, (due - now) * 1000));
          if (this.playing) await this._show(sample);
        } finally {
          sample.close();
        }
      }
    } catch (e) {
      this.hooks.onError(`Playback stopped: ${e.message}`);
    } finally {
      await it.return().catch(() => {});
      this.playing = false;
      this.hooks.onTime(this.time);
    }
  }

  pause() { this.playing = false; }

  dispose() {
    this.playing = false;
    if (this.texture) this.hooks.renderer.release(this.texture);
    this.texture = null;
  }
}

export function formatTime(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - 60 * m).toFixed(1).padStart(4, '0')}`;
}
