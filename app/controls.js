// Basic controls panel, built from looks.json `basicControls` (parsed from the
// Mac app's ControlRegistryData.swift). Value labels follow its ValueUnit.

import { getKey } from './engine/settings.js';

function formatValue(spec, v) {
  switch (spec.unit) {
    case 'stops': return `${v >= 0 ? '+' : ''}${v.toFixed(1)} stops`;
    case 'percentOfRange': return `${Math.round(100 * (v - spec.min) / (spec.max - spec.min))} %`;
    case 'signedHundred': return `${v >= 0 ? '+' : ''}${Math.round(100 * v)}`;
    case 'relativePercent': return `${v >= 1 ? '+' : ''}${Math.round(100 * (v - 1))} %`;
    default: return String(v);
  }
}

/// Builds the controls into `root`. `onChange(key, value)` on user input,
/// `onRevert(key)` on a control's revert arrow. Returns `update(settings, lookSettings)`.
export function buildControls(root, specs, formats, onChange, onRevert) {
  const rows = specs.map((spec) => {
    const row = document.createElement('div');
    row.className = 'control';
    const id = `ctl-${spec.id}`;
    const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: spec.label, title: spec.help });
    const out = document.createElement('output');
    const revert = Object.assign(document.createElement('button'), { className: 'revert', type: 'button',
      textContent: '↺', title: "Put back the look's own value" });
    revert.setAttribute('aria-label', `Reset ${spec.label}`);
    revert.addEventListener('click', () => onRevert(spec.key));
    let input;
    if (spec.kind === 'choice') {
      input = document.createElement('select');
      for (const o of spec.options) input.append(new Option(o.label, o.value));
      input.addEventListener('change', () => onChange(spec.key, input.value));
    } else {
      input = Object.assign(document.createElement('input'), { type: 'range', min: spec.min, max: spec.max,
        step: (spec.max - spec.min) / 200 });
      input.addEventListener('input', () => onChange(spec.key, Number(input.value)));
      input.addEventListener('dblclick', () => onRevert(spec.key));
    }
    input.id = id;
    input.title = spec.help;
    row.append(label, out, revert, input);
    root.append(row);
    return { spec, row, input, out };
  });

  return function update(settings, lookSettings) {
    for (const { spec, row, input, out } of rows) {
      const v = getKey(settings, spec.key, formats);
      const own = getKey(lookSettings, spec.key, formats);
      if (spec.kind === 'choice') {
        input.value = v;
        out.textContent = '';
      } else {
        if (document.activeElement !== input) input.value = v;
        out.textContent = formatValue(spec, v);
      }
      row.classList.toggle('changed', v !== own);
    }
  };
}
