// FilmBench web page: open a photo or a video, pick a look, adjust, compare, export.
// Video specifics (preview playback, MP4 export) live in video/page.js.
// Everything runs in this browser tab; no network requests besides the page's own files.

import { FilmRenderer } from './engine/renderer.js';
import { cloneSettings, getKey, setKey } from './engine/settings.js';
import { buildControls } from './controls.js';
import { VideoPage, isVideoFile } from './video/page.js';

const PREVIEW_MAX = 2048;      // long side of the on-screen render
const THUMB_MAX = 240;         // long side of a look thumbnail
const EXPORT_PIXEL_CAP = 8192; // long side cap for export, below the device limit when that is larger

const $ = (id) => document.getElementById(id);
const state = {
  doc: null, renderer: null, look: null, original: false, comparing: false,
  overrides: {},          // user-changed keys, kept when switching looks
  bitmap: null, fileName: 'photo', preview: null, previewOut: null, pending: false,
  video: null,            // VideoPage; active while a video is open
  split: { on: true, x: 0.5 }, // before/after divider on screen (as the Mac app: on, in the middle)
};

function showError(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = !message;
}

function currentSettings() {
  const s = cloneSettings(state.look.settings);
  for (const [k, v] of Object.entries(state.overrides)) setKey(s, k, v, state.doc.filmFormatsMM);
  return s;
}

// ---- looks list ----------------------------------------------------------------------

function buildLookList() {
  const root = $('look-list');
  const groups = [{ name: 'Original', looks: [null] },
    ...state.doc.groups.map((g) => ({ name: g, looks: state.doc.looks.filter((l) => l.group === g) }))
      .filter((g) => g.looks.length)];
  for (const g of groups) {
    const section = document.createElement('div');
    section.className = 'look-group';
    section.append(Object.assign(document.createElement('h3'), { textContent: g.name }));
    const tiles = Object.assign(document.createElement('div'), { className: 'tiles' });
    for (const look of g.looks) {
      const tile = Object.assign(document.createElement('button'), { className: 'tile', type: 'button' });
      const canvas = document.createElement('canvas');
      canvas.width = 3; canvas.height = 2;
      tile.append(canvas, document.createTextNode(look ? look.name : 'Original'));
      tile.dataset.look = look ? look.name : '';
      tile.title = look ? look.info : 'Your picture without the look';
      tile.addEventListener('click', () => selectLook(look));
      tiles.append(tile);
    }
    section.append(tiles);
    root.append(section);
  }
}

function markSelected() {
  for (const t of document.querySelectorAll('.tile')) {
    const on = state.original ? t.dataset.look === '' : t.dataset.look === state.look.name;
    t.setAttribute('aria-pressed', String(on));
  }
  const info = $('look-info');
  if (state.original) { info.textContent = 'Original: your picture without the look. Click a look to bring it back.'; return; }
  const basis = state.look.basis === 'data' ? 'From published data' : 'Approximation';
  info.innerHTML = '';
  info.append(Object.assign(document.createElement('strong'), { textContent: state.look.name }),
    document.createTextNode(` · ${basis}. ${state.look.info}`));
}

function selectLook(look) {
  state.original = !look;
  if (look) state.look = look;
  markSelected();
  updateControls();
  updateSplit();
  scheduleRender();
}

// ---- controls --------------------------------------------------------------------------

let updateControls = () => {};

function onControl(key, value) {
  const own = getKey(state.look.settings, key, state.doc.filmFormatsMM);
  if (value === own) delete state.overrides[key]; else state.overrides[key] = value;
  if (state.original) { state.original = false; markSelected(); updateSplit(); }
  updateControls();
  scheduleRender();
}

function onRevert(key) {
  delete state.overrides[key];
  updateControls();
  scheduleRender();
}

// ---- rendering --------------------------------------------------------------------------

function fitSize(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function scaledTexture(bitmap, max) {
  const [w, h] = fitSize(bitmap.width, bitmap.height, max);
  const src = (w === bitmap.width && h === bitmap.height) ? bitmap
    : await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  return state.renderer.importImage(src);
}

function scheduleRender() {
  if (!(state.preview || state.video?.active) || state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    renderPreview();
  });
}

function renderPreview() {
  if (state.video?.active) { state.video.redraw(); return; }
  const r = state.renderer;
  if (state.previewOut) r.release(state.previewOut);
  state.previewOut = null;
  const showOriginal = state.original || state.comparing;
  try {
    if (!showOriginal) state.previewOut = r.render(state.preview, currentSettings());
    r.present(showOriginal ? state.preview : state.previewOut, $('view').getContext('webgpu'), presentOptions(state.preview));
    showError('');
  } catch (e) {
    showError(`Could not render this look: ${e.message}`);
  }
}

async function renderThumbnails() {
  document.body.dataset.thumbs = 'running';
  const r = state.renderer;
  const thumb = await scaledTexture(state.bitmap, THUMB_MAX);
  for (const tile of document.querySelectorAll('.tile')) {
    const look = state.doc.looks.find((l) => l.name === tile.dataset.look);
    const s = look ? cloneSettings(look.settings) : null;
    if (s) for (const [k, v] of Object.entries(state.overrides)) setKey(s, k, v, state.doc.filmFormatsMM);
    const out = s ? r.render(thumb, s) : thumb;
    const bytes = await r.readSRGB8(out);
    if (s) r.release(out);
    const canvas = tile.querySelector('canvas');
    canvas.width = thumb.width; canvas.height = thumb.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer), thumb.width, thumb.height), 0, 0);
  }
  r.release(thumb);
  document.body.dataset.thumbs = 'done';
}

// ---- open ----------------------------------------------------------------------------------

function dropPhoto() {
  if (state.preview) state.preview.destroy();
  if (state.previewOut) state.previewOut.destroy();
  state.preview = null;
  state.previewOut = null;
}

async function openVideo(file) {
  $('status').textContent = `Opening ${file.name}…`;
  dropPhoto();
  state.renderer.trimPool();
  try {
    state.bitmap = await state.video.open(file);
  } catch (e) {
    showError(`This video could not be opened: ${e.message}`);
    $('status').textContent = '';
    return;
  }
  $('view').hidden = false;
  document.body.dataset.state = 'ready';
  $('compare').disabled = false;
  $('split-toggle').disabled = false;
  updateControls();
  updateSplit();
  state.video.redraw();
  renderThumbnails().catch((e) => showError(`Thumbnails failed: ${e.message}`));
}

async function openFile(file) {
  if (!file) return;
  showError('');
  if (isVideoFile(file)) { await openVideo(file); return; }
  state.video.close();
  $('status').textContent = `Opening ${file.name}…`;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  } catch (e) {
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/.test(file.type);
    showError(heic ? 'This browser cannot read HEIC pictures. Safari can; or save the picture as JPEG first.'
      : `This file could not be read as a picture (${e.message}).`);
    $('status').textContent = '';
    return;
  }
  state.bitmap = bitmap;
  state.fileName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  dropPhoto();
  state.renderer.trimPool();
  state.preview = await scaledTexture(bitmap, PREVIEW_MAX);
  const view = $('view');
  view.width = state.preview.width; view.height = state.preview.height;
  view.hidden = false;
  document.body.dataset.state = 'ready';
  $('compare').disabled = false;
  $('split-toggle').disabled = false;
  $('export-button').disabled = false;
  updateControls();
  updateSplit();
  $('status').textContent = `${bitmap.width} × ${bitmap.height} px`;
  updateExportNote();
  renderPreview();
  renderThumbnails().catch((e) => showError(`Thumbnails failed: ${e.message}`));
}

function setupDrop() {
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    openFile(e.dataTransfer.files[0]);
  });
  $('file-input').addEventListener('change', (e) => openFile(e.target.files[0]));
}

// ---- compare --------------------------------------------------------------------------------

function setComparing(on) {
  if (state.comparing === on) return;
  state.comparing = on;
  $('compare').textContent = on ? 'Original' : 'Hold to compare';
  updateSplit();
  scheduleRender();
}

function setupCompare() {
  const b = $('compare');
  b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); setComparing(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => setComparing(false));
  window.addEventListener('keydown', (e) => { if (e.key === '\\' && (state.preview || state.video.active)) setComparing(true); });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') setComparing(false); });
}

// ---- before/after split ---------------------------------------------------------------------

function isSplitShown() {
  return state.split.on && !state.original && !state.comparing && !!(state.preview || state.video?.active);
}

/// present() options for the screen: the source left of the divider. Exports never call this.
function presentOptions(source) {
  return isSplitShown() ? { before: source, split: state.split.x } : {};
}

function updateSplit() {
  const el = $('split');
  el.hidden = !isSplitShown();
  el.style.setProperty('--x', `${100 * state.split.x}%`);
  $('stage').classList.toggle('splitting', isSplitShown());
  const b = $('split-toggle');
  b.setAttribute('aria-pressed', String(state.split.on));
  b.textContent = state.split.on ? 'Split: on' : 'Split: off';
}

function moveSplit(clientX) {
  const rect = $('view').getBoundingClientRect();
  if (rect.width <= 0) return;
  state.split.x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  updateSplit();
  scheduleRender();
}

function setupSplit() {
  $('split-toggle').addEventListener('click', () => {
    state.split.on = !state.split.on;
    updateSplit();
    scheduleRender();
  });
  const stage = $('stage');
  let dragging = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!isSplitShown() || e.button > 0) return;
    dragging = e.pointerId;
    stage.setPointerCapture(e.pointerId);
    moveSplit(e.clientX);
  });
  stage.addEventListener('pointermove', (e) => { if (dragging === e.pointerId) moveSplit(e.clientX); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(ev, (e) => { if (dragging === e.pointerId) dragging = null; });
  }
  updateSplit();
}

// ---- export ---------------------------------------------------------------------------------

function exportSize() {
  const max = Math.min(state.renderer.maxTextureSize, EXPORT_PIXEL_CAP);
  return { max, size: fitSize(state.bitmap.width, state.bitmap.height, max) };
}

function updateExportNote() {
  const { max, size } = exportSize();
  const full = size[0] === state.bitmap.width && size[1] === state.bitmap.height;
  $('export-note').textContent = full ? `Exports at full size, ${size[0]} × ${size[1]} px.`
    : `Your picture is ${state.bitmap.width} × ${state.bitmap.height} px; this page renders at most ${max} px on a side `
      + `on this device, so it exports at ${size[0]} × ${size[1]} px.`;
}

async function exportImage() {
  const button = $('export-button');
  button.disabled = true;
  $('status').textContent = 'Exporting…';
  try {
    const r = state.renderer;
    const input = await scaledTexture(state.bitmap, exportSize().max);
    const out = state.original ? input : r.render(input, currentSettings());
    const bytes = await r.readSRGB8(out);
    if (out !== input) r.release(out);
    r.release(input);
    const canvas = new OffscreenCanvas(out.width, out.height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer), out.width, out.height), 0, 0);
    const fmt = $('export-format').value;
    const blob = await canvas.convertToBlob({ type: `image/${fmt}`, quality: Number($('export-quality').value) / 100 });
    const name = `${state.fileName} ${state.original ? 'original' : state.look.name}.${fmt === 'jpeg' ? 'jpg' : 'png'}`;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('status').textContent = `Saved ${name} (${out.width} × ${out.height} px)`;
  } catch (e) {
    showError(`Export failed: ${e.message}`);
  } finally {
    button.disabled = false;
  }
}

function setupExport() {
  const q = $('export-quality');
  q.addEventListener('input', () => { $('quality-value').textContent = q.value; });
  $('export-format').addEventListener('change', () => { $('quality-row').hidden = $('export-format').value !== 'jpeg'; });
  $('export-button').addEventListener('click', exportImage);
}

// ---- start -----------------------------------------------------------------------------------

function showNoWebGPU() {
  $('no-webgpu').hidden = false;
  document.body.dataset.state = 'no-gpu';
}

async function start() {
  if (!navigator.gpu) { showNoWebGPU(); return; }
  try {
    state.renderer = await FilmRenderer.create();
  } catch {
    showNoWebGPU(); // no adapter: same advice as no WebGPU at all
    return;
  }
  state.doc = await (await fetch('looks.json')).json();
  state.look = state.doc.looks[0];
  state.video = new VideoPage({
    renderer: state.renderer, context: $('view').getContext('webgpu'),
    settings: () => (state.original || state.comparing ? null : currentSettings()),
    presentOptions,
    lookName: () => state.look.name,
    showError,
    setStatus: (text) => { $('status').textContent = text; },
  });
  buildLookList();
  const update = buildControls({ basicRoot: $('controls'), advRoot: $('advanced-controls'),
    basic: state.doc.basicControls, advanced: state.doc.advancedControls, formats: state.doc.filmFormatsMM,
    onChange: onControl, onRevert });
  updateControls = () => update(currentSettings(), state.look.settings, !!state.video?.active);
  markSelected();
  updateControls();
  $('reset').addEventListener('click', () => { state.overrides = {}; updateControls(); scheduleRender(); });
  setupDrop();
  setupCompare();
  setupSplit();
  setupExport();
}

start().catch((e) => showError(`The page could not start: ${e.message}`));
