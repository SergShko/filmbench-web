// Basic and Advanced control panels, built from looks.json `basicControls` and
// `advancedControls` (parsed from the Mac app's ControlRegistryData.swift and
// ControlRegistry.swift). Value labels follow its ValueUnit.

import { getKey } from './engine/settings.js';

const sign = (v) => (v >= 0 ? '+' : '');

function formatValue(spec, unit, v) {
  const t = (v - spec.min) / (spec.max - spec.min);
  switch (unit) {
    case 'stops': return `${sign(v)}${v.toFixed(1)} stops`;
    case 'percentOfRange': return `${Math.round(100 * (spec.inverted ? 1 - t : t))} %`;
    case 'signedHundred': return `${sign(v)}${Math.round(100 * v)}`;
    case 'relativePercent': return `${sign(v - 1)}${Math.round(100 * (v - 1))} %`;
    case 'micrometres': return `${v.toFixed(1)} µm`;
    case 'percentOfWidth': return `${(100 * v).toFixed(2)} %`;
    case 'printerPoints': return `${sign(v)}${v.toFixed(1)} pts`;
    case 'plain': return v.toFixed(spec.digits ?? 2);
    default: return String(v);
  }
}

function makeInput(spec, onChange, onRevert) {
  if (spec.kind === 'choice') {
    const input = document.createElement('select');
    for (const o of spec.options) input.append(new Option(o.label, o.value));
    input.addEventListener('change', () => onChange(spec.key, input.value));
    return input;
  }
  if (spec.kind === 'toggle') {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox' });
    input.addEventListener('change', () => onChange(spec.key, input.checked));
    return input;
  }
  const input = Object.assign(document.createElement('input'), { type: 'range', min: spec.min, max: spec.max,
    step: spec.step ?? (spec.max - spec.min) / 200 });
  const flip = (x) => (spec.inverted ? spec.min + spec.max - x : x);
  input.addEventListener('input', () => onChange(spec.key, flip(Number(input.value))));
  input.addEventListener('dblclick', () => onRevert(spec.key));
  input.flip = flip;
  return input;
}

function makeRow(spec, onChange, onRevert) {
  const row = document.createElement('div');
  row.className = `control ${spec.kind}`;
  row.dataset.key = spec.key;
  const id = `ctl-${spec.id}`;
  const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: spec.label, title: spec.help });
  const out = document.createElement('output');
  const revert = Object.assign(document.createElement('button'), { className: 'revert', type: 'button',
    textContent: '↺', title: "Put back the look's own value" });
  revert.setAttribute('aria-label', `Reset ${spec.label}`);
  revert.addEventListener('click', () => onRevert(spec.key));
  const input = makeInput(spec, onChange, onRevert);
  input.id = id;
  input.title = spec.help;
  row.append(label, out, revert, input);
  return { spec, row, input, out };
}

function updateRow({ spec, row, input, out }, settings, lookSettings, formats, advancedOpen) {
  const v = getKey(settings, spec.key, formats);
  const own = getKey(lookSettings, spec.key, formats);
  if (spec.kind === 'choice') {
    input.value = v;
    out.textContent = '';
  } else if (spec.kind === 'toggle') {
    input.checked = !!v;
    out.textContent = v ? 'On' : 'Off';
  } else {
    if (document.activeElement !== input) input.value = input.flip(v);
    out.textContent = formatValue(spec, advancedOpen && spec.advancedUnit ? spec.advancedUnit : spec.unit, v);
  }
  const changed = v !== own;
  row.classList.toggle('changed', changed);
  return changed;
}

/// True when a `visibleWhen` rule ({media: 'video'}, {processes: [...]}) holds.
export function isVisible(rule, settings, isVideo) {
  if (rule.media === 'video' && !isVideo) return false;
  if (rule.processes && !rule.processes.includes(settings.film.process)) return false;
  return true;
}

function buildGroup(root, group, onChange, onRevert) {
  const section = Object.assign(document.createElement('div'), { className: 'adv-group' });
  section.dataset.group = group.id;
  const header = Object.assign(document.createElement('button'), { type: 'button', className: 'adv-group-header',
    textContent: group.label });
  header.setAttribute('aria-expanded', 'false');
  const body = Object.assign(document.createElement('div'), { className: 'adv-group-body', hidden: true });
  header.addEventListener('click', () => {
    body.hidden = !body.hidden;
    header.setAttribute('aria-expanded', String(!body.hidden));
  });
  const rows = group.controls.map((spec) => makeRow(spec, onChange, onRevert));
  body.append(...rows.map((r) => r.row));
  section.append(header, body);
  root.append(section);
  return { group, section, header, rows };
}

/// Builds Basic into `basicRoot` and the collapsible Advanced section into `advRoot`.
/// `onChange(key, value)` on user input, `onRevert(key)` on a control's revert arrow.
/// Returns `update(settings, lookSettings, isVideo)`.
export function buildControls({ basicRoot, advRoot, basic, advanced, formats, onChange, onRevert }) {
  const basicRows = basic.map((spec) => makeRow(spec, onChange, onRevert));
  basicRoot.append(...basicRows.map((r) => r.row));

  const details = Object.assign(document.createElement('details'), { className: 'advanced', id: 'advanced' });
  const summary = Object.assign(document.createElement('summary'), { textContent: 'Advanced' });
  details.append(summary);
  const groups = advanced.map((g) => buildGroup(details, g, onChange, onRevert));
  advRoot.append(details);

  let last = null;
  details.addEventListener('toggle', () => { if (last) update(...last); });

  function update(settings, lookSettings, isVideo) {
    last = [settings, lookSettings, isVideo];
    for (const r of basicRows) updateRow(r, settings, lookSettings, formats, details.open);
    for (const g of groups) {
      g.section.hidden = !isVisible(g.group.visibleWhen, settings, isVideo);
      let changed = false;
      for (const r of g.rows) {
        r.row.hidden = !isVisible(r.spec.visibleWhen, settings, isVideo);
        changed = updateRow(r, settings, lookSettings, formats, true) || changed;
      }
      g.header.classList.toggle('changed', changed);
    }
  }
  return update;
}
