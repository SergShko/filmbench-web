// The video half of the page: open a clip, preview it (play, pause, scrub), export
// MP4 with progress and Cancel. app.js owns looks and controls (the video effects are
// in Advanced, Video extras) and calls in here when the opened file is a video.

import { MB, openClip, workingSize, HDR_MESSAGE } from './clip.js';
import { Player, formatTime } from './player.js';
import { exportClip, estimateBytes, ExportStopped } from './export.js';

const $ = (id) => document.getElementById(id);
const MEMORY_WARN_BYTES = 1024 ** 3;
const SCRUB_STEPS = 1000;

export const isVideoFile = (file) => file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(file.name);

export class VideoPage {
  /// hooks: { renderer, context, settings() -> LookSettings | null, lookName() -> string,
  ///          presentOptions(source) -> present() options (the on-screen split),
  ///          showError(message), setStatus(text) }
  constructor(hooks) {
    this.hooks = hooks;
    this.clip = null;
    this.player = null;
    this.exporting = null; // { controller } while an export runs
    this._wire();
  }

  get active() { return !!this.clip; }

  /// Open a video file. Returns an ImageBitmap of the first frame (for look thumbnails).
  async open(file) {
    this.close();
    const clip = await openClip(file);
    this.clip = clip;
    this.fileName = file.name.replace(/\.[^.]+$/, '') || 'video';
    this.player = new Player(clip, { renderer: this.hooks.renderer, context: this.hooks.context,
      settings: this.hooks.settings, presentOptions: this.hooks.presentOptions, onTime: (t) => this._onTime(t), onError: this.hooks.showError });
    const [w, h] = [this.player.w, this.player.h];
    const view = $('view');
    view.width = w; view.height = h;
    await this.player.seek(clip.info.firstTimestamp);
    this._showInfo();
    return this._firstFrameBitmap();
  }

  async _firstFrameBitmap() {
    const sample = await this.player.sink.getSample(this.clip.info.firstTimestamp);
    if (!sample) throw new Error('the video track has no frames');
    const frame = sample.toVideoFrame();
    try {
      return await createImageBitmap(frame);
    } finally {
      frame.close();
      sample.close();
    }
  }

  close() {
    this.exporting?.controller.cancel?.();
    this.player?.dispose();
    this.clip?.input.dispose();
    this.clip = null;
    this.player = null;
    $('video-bar').hidden = true;
    $('video-export').hidden = true;
    $('video-note').hidden = true;
    $('photo-export').hidden = false;
  }

  redraw() { if (this.player && !this.player.playing) this.player.redraw(); }

  // ---- UI -------------------------------------------------------------------------------

  _wire() {
    $('play').addEventListener('click', () => this._togglePlay());
    $('scrub').addEventListener('input', () => {
      if (!this.player) return;
      this.player.pause();
      this.player.seek(this.player.start + (Number($('scrub').value) / SCRUB_STEPS) * this.clip.info.duration);
    });
    $('video-size').addEventListener('change', () => this._updateExportNote());
    $('video-quality').addEventListener('change', () => this._updateExportNote());
    $('video-export-button').addEventListener('click', () => this.export());
    $('video-cancel').addEventListener('click', () => this.exporting?.controller.cancel?.());
  }

  async _togglePlay() {
    if (!this.player) return;
    if (this.player.playing) { this.player.pause(); return; }
    $('play').textContent = 'Pause';
    await this.player.play();
    $('play').textContent = 'Play';
  }

  _onTime(t) {
    const { firstTimestamp: t0, duration } = this.clip.info;
    $('scrub').value = String(Math.round(((t - t0) / Math.max(duration, 1e-6)) * SCRUB_STEPS));
    $('time').textContent = `${formatTime(t - t0)} / ${formatTime(duration)}`;
  }

  _showInfo() {
    const i = this.clip.info;
    $('photo-export').hidden = true;
    $('video-bar').hidden = false;
    $('video-export').hidden = false;
    const notes = [];
    if (i.hdr) notes.push(HDR_MESSAGE);
    if (i.audioTracks > 1) notes.push(`This clip has ${i.audioTracks} audio tracks; the export keeps only the first.`);
    $('video-note').textContent = notes.join(' ');
    $('video-note').hidden = !notes.length;
    $('video-export-button').disabled = i.hdr;
    const rot = i.rotation ? `, rotated ${i.rotation}°` : '';
    this.hooks.setStatus(`${i.displayWidth} × ${i.displayHeight} px, ${i.frameRate.toFixed(2)} fps, `
      + `${formatTime(i.duration)}${rot}, ${i.codec ?? 'video'}${i.audioCodec ? ` + ${i.audioCodec}` : ', no audio'}`);
    this._onTime(i.firstTimestamp);
    this._updateExportNote();
  }

  _exportOptions() {
    return { maxDim: Number($('video-size').value), quality: $('video-quality').value };
  }

  _updateExportNote(extra = '') {
    if (!this.clip) return;
    const { maxDim, quality } = this._exportOptions();
    const [w, h] = workingSize(this.clip.info, maxDim);
    const mb = estimateBytes(this.clip, w, h, quality) / 1e6;
    const streaming = typeof window.showSaveFilePicker === 'function';
    const memory = streaming ? '' : ` This browser cannot write straight to disk, so the file is built in memory first${
      mb * 1e6 > MEMORY_WARN_BYTES ? ': at this size the tab may run out of memory; choose 1080p or a shorter clip' : ''}.`;
    $('video-export-note').textContent = `Exports H.264 MP4 at ${w} × ${h} px, about ${Math.max(1, Math.round(mb))} MB.${memory}${extra}`;
  }

  // ---- export ---------------------------------------------------------------------------

  async _target(name) {
    if (typeof window.showSaveFilePicker !== 'function') return { target: new MB.BufferTarget(), handle: null };
    const handle = await window.showSaveFilePicker({ suggestedName: name,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
    const writable = await handle.createWritable();
    return { target: new MB.StreamTarget(writable, { chunked: true, chunkSize: 8 * 2 ** 20 }), handle };
  }

  async export() {
    if (!this.clip || this.exporting) return;
    this.player.pause();
    const settings = this.hooks.settings();
    const name = `${this.fileName} ${settings ? this.hooks.lookName() : 'original'}.mp4`;
    let dest;
    try {
      dest = await this._target(name);
    } catch (e) {
      if (e.name !== 'AbortError') this.hooks.showError(`Could not open the file to save: ${e.message}`);
      return;
    }
    const controller = {};
    this.exporting = { controller };
    this._setExporting(true);
    this.hooks.showError('');
    try {
      const result = await exportClip(this.hooks.renderer, this.clip, dest.target, { ...this._exportOptions(),
        settings, controller, onProgress: (p) => this._progress(p) });
      if (!dest.handle) download(dest.target.buffer, name);
      this.hooks.setStatus(`Saved ${name}: ${result.frames} frames at ${result.width} × ${result.height} px, `
        + `${(result.frames / result.seconds).toFixed(1)} frames/s, audio ${result.audio}`);
      document.body.dataset.videoExport = 'done';
    } catch (e) {
      const left = await removePartial(dest.handle);
      this.hooks.showError((e instanceof ExportStopped ? e.message : `Export failed: ${e.message}`) + left);
      document.body.dataset.videoExport = e instanceof ExportStopped ? 'stopped' : 'failed';
    } finally {
      this.exporting = null;
      this._setExporting(false);
    }
  }

  _setExporting(on) {
    $('video-export-button').disabled = on || this.clip?.info.hdr;
    $('video-cancel').hidden = !on;
    $('video-progress').hidden = !on;
    $('video-progress').value = 0;
    document.body.dataset.videoExport = on ? 'running' : document.body.dataset.videoExport;
  }

  _progress({ frames, total, fps }) {
    $('video-progress').value = total ? Math.min(frames / total, 1) : 0;
    this.hooks.setStatus(`Exporting frame ${frames} of ${total} (${fps.toFixed(1)} frames/s)…`);
  }
}

/// Delete the partly written file of a stopped export. Returns '' or a sentence saying
/// the file is still on disk (the browser has no remove(), or it refused).
async function removePartial(handle) {
  if (!handle) return '';
  const keep = ` The partly written file ${handle.name} is still on disk; delete it.`;
  if (typeof handle.remove !== 'function') return keep;
  try {
    await handle.remove();
    return '';
  } catch (err) {
    console.warn('could not remove the partial export', err);
    return keep;
  }
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'video/mp4' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
