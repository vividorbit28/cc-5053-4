/*
 * Control panel controller.
 *
 * UI → engine → worklet for commands; worklet → engine → UI for state,
 * telemetry, captured audio and errors.  Every control change is echoed by
 * the worklet's `state` message; a rejected change (ModelError) rolls the
 * control back to the last applied value and surfaces the message.
 */

import { AudioEngine, frequencyForStringLength, stringLengthForFrequency } from '../audio/engine.js';
import {
  noteName,
  frequencyToMidi,
  predictedT60ForFrequency,
  solveLoop,
  loopGainForT60
} from '../core/string-model.js';
import {
  refineFrequency,
  cents,
  measureDecay,
  totalEnergy,
  peakOf
} from '../core/analysis.js';
import { renderAndAnalyse, encodeWav } from '../core/offline.js';
import { StringView, DecayView, PartialView, ScopeView } from './views.js';
import { initLibrary } from './library.js';

const $ = (id) => document.getElementById(id);

const engine = new AudioEngine();
const stringView = new StringView($('stringCanvas'), ({ position, depth }) => {
  // The canvas allows plucking from either end; the physical modal weight
  // |sin(kπβ)| is symmetric, so reflect positions past the midpoint.
  const beta = Math.min(position, 1 - position);
  setSlider('pluckPos', beta);
  updatePositions();
  sendConfigure();
  const amplitude = 0.25 + depth * 0.75;
  doExcite(amplitude, beta);
});
const decayView = new DecayView($('decayCanvas'));
const partialView = new PartialView($('partialCanvas'));
const scopeView = new ScopeView($('scopeCanvas'));

const state = {
  started: false,
  sampleRate: 48000,
  applied: null,
  excitation: 'pluck',
  lastAppliedParams: null,
  capture: { active: false, chunks: [], startedAt: 0 },
  muted: false,
  clipCount: 0,
  faulted: false,
  chipHoldUntil: 0,
  analysisTimer: null
};

const NOTE_PRESETS = [
  { name: 'E2', frequency: 82.41 },
  { name: 'A2', frequency: 110 },
  { name: 'D3', frequency: 146.83 },
  { name: 'G3', frequency: 196 },
  { name: 'A3', frequency: 220 },
  { name: 'E4', frequency: 329.63 },
  { name: 'A4', frequency: 440 },
  { name: 'E5', frequency: 659.26 }
];

/* ───────────────────────────── helpers ──────────────────────────────── */

let toastTimer = null;
function toast(message, tone = 'bad', ms = 4200) {
  const el = $('toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

function setChip(id, text, tone = null) {
  const el = $(id);
  const textEl = el.querySelector('[data-text]');
  if (textEl) textEl.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setText(id, value, tone = null) {
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  if (el.tagName === 'SMALL' || el.tagName === 'DD') {
    el.classList.remove('good', 'warn', 'bad');
    if (tone) el.classList.add(tone);
  }
}

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function signed(value, digits = 2, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const s = value >= 0 ? '+' : '';
  return s + value.toFixed(digits) + unit;
}

function dbFromGain(g) {
  if (!(g > 0)) return '-∞';
  return (20 * Math.log10(g)).toFixed(2);
}

function setSlider(id, value) {
  const el = $(id);
  const min = Number(el.min);
  const max = Number(el.max);
  el.value = String(Math.min(max, Math.max(min, value)));
  paintRange(el);
}

function paintRange(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', pct.toFixed(1) + '%');
}

/* ───────────────────────────── controls ─────────────────────────────── */

const controls = {
  length: $('length'),
  t60: $('t60'),
  damping: $('damping'),
  pluckPos: $('pluckPos'),
  pickupPos: $('pickupPos'),
  master: $('master')
};

for (const el of Object.values(controls)) {
  paintRange(el);
  el.addEventListener('input', onControlInput);
  el.addEventListener('change', onControlChange);
}

$('dampingAuto').addEventListener('change', () => {
  controls.damping.disabled = $('dampingAuto').checked;
  updateControlLabels();
  sendConfigure();
});

function onControlInput(event) {
  const id = event.target.id;
  if (id === 'length') {
    const length = Number(controls.length.value);
    $('lengthOut').textContent = length.toFixed(3) + ' m';
    const f = frequencyForStringLength(length);
    $('factLength').textContent = length.toFixed(3);
    $('factPitch').textContent = noteName(f);
    $('factHz').textContent = f.toFixed(1);
    setChip('chipPitch', noteName(f) + ' · ' + f.toFixed(1) + ' Hz', 'good');
  } else if (id === 't60') {
    $('t60Out').textContent = Number(controls.t60.value).toFixed(1) + ' s';
  } else if (id === 'damping') {
    $('dampingOut').textContent = Number(controls.damping.value).toFixed(3);
  } else if (id === 'pluckPos') {
    $('pluckPosOut').textContent = (Number(controls.pluckPos.value) * 100).toFixed(0) + '%';
    updatePositions();
  } else if (id === 'pickupPos') {
    $('pickupPosOut').textContent = (Number(controls.pickupPos.value) * 100).toFixed(0) + '%';
    updatePositions();
  } else if (id === 'master') {
    $('masterOut').textContent = Number(controls.master.value).toFixed(2);
    if (state.started) engine.setMaster(Number(controls.master.value));
  }
  paintRange(event.target);
  highlightNotePreset();
}

let configureQueued = false;
function onControlChange() {
  if (!state.started) return;
  if (configureQueued) return;
  configureQueued = true;
  requestAnimationFrame(() => {
    configureQueued = false;
    sendConfigure();
  });
}

function sendConfigure() {
  if (!state.started) return;
  const dampingAuto = $('dampingAuto').checked;
  const params = {
    lengthMeters: Number(controls.length.value),
    t60: Number(controls.t60.value),
    damping: dampingAuto ? null : Number(controls.damping.value),
    pluckPosition: Number(controls.pluckPos.value),
    pickupPosition: Number(controls.pickupPos.value)
  };
  state.pendingParams = params;
  try {
    engine.configure(params);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function updateControlLabels() {
  const length = Number(controls.length.value);
  $('lengthOut').textContent = length.toFixed(3) + ' m';
  $('t60Out').textContent = Number(controls.t60.value).toFixed(1) + ' s';
  $('dampingOut').textContent = $('dampingAuto').checked
    ? 'auto'
    : Number(controls.damping.value).toFixed(3);
  $('pluckPosOut').textContent = (Number(controls.pluckPos.value) * 100).toFixed(0) + '%';
  $('pickupPosOut').textContent = (Number(controls.pickupPos.value) * 100).toFixed(0) + '%';
  $('masterOut').textContent = Number(controls.master.value).toFixed(2);
  controls.damping.disabled = $('dampingAuto').checked;
}

function updatePositions() {
  const beta = Number(controls.pluckPos.value);
  const gamma = Number(controls.pickupPos.value);
  stringView.setPositions(beta, gamma);
  $('factPluck').textContent = (beta * 100).toFixed(0) + '%';
  $('factPickup').textContent = (gamma * 100).toFixed(0) + '%';
}

/* ───────────────────────────── note presets ─────────────────────────── */

function buildNotePresets() {
  const host = $('notes');
  host.innerHTML = '';
  for (const preset of NOTE_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'notebtn';
    btn.textContent = preset.name;
    btn.dataset.frequency = String(preset.frequency);
    btn.title = preset.frequency + ' Hz · ' + stringLengthForFrequency(preset.frequency).toFixed(3) + ' m';
    btn.addEventListener('click', () => {
      const length = stringLengthForFrequency(preset.frequency);
      setSlider('length', Math.min(1.8, Math.max(0.14, length)));
      onControlInput({ target: controls.length });
      sendConfigure();
      if (state.started) pluckNow(0.6);
      highlightNotePreset();
    });
    host.appendChild(btn);
  }
}

function highlightNotePreset() {
  const f = frequencyForStringLength(Number(controls.length.value));
  const midi = Math.round(frequencyToMidi(f));
  for (const btn of document.querySelectorAll('.notebtn')) {
    const target = Math.round(frequencyToMidi(Number(btn.dataset.frequency)));
    btn.classList.toggle('active', Math.abs(target - midi) < 0.5);
  }
}

/* ───────────────────────────── excitation ───────────────────────────── */

function pluckNow(amplitude = 0.6) {
  if (!state.started) {
    toast('Start audio first', 'warn');
    return;
  }
  const beta = Number(controls.pluckPos.value);
  doExcite(amplitude, beta);
}

function doExcite(amplitude, beta) {
  if (!state.started || state.faulted) {
    if (state.faulted) toast('Model faulted — press Reset', 'bad');
    return;
  }
  state.muted = false;
  updateMuteButton();
  decayView.reset();
  partialView.set([], []);
  startCapture();
  try {
    if (state.excitation === 'burst') {
      engine.burst(amplitude * 0.75, 2.5, beta);
    } else {
      engine.pluck(amplitude, beta);
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('pluckBtn').addEventListener('click', () => {
  if (!state.started) {
    startAudio();
    return;
  }
  pluckNow(0.6);
});

for (const btn of document.querySelectorAll('[data-excitation]')) {
  btn.addEventListener('click', () => {
    state.excitation = btn.dataset.excitation;
    for (const other of document.querySelectorAll('[data-excitation]')) {
      other.classList.toggle('active', other === btn);
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  const tag = (event.target && event.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
  event.preventDefault();
  if (!state.started) startAudio();
  else pluckNow(0.6);
});

/* ───────────────────────────── audio start ──────────────────────────── */

async function startAudio() {
  const btn = $('startAudio');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await engine.start();
    state.started = true;
    state.sampleRate = engine.context.sampleRate;
    $('chipRate').querySelector('[data-text]').textContent =
      (state.sampleRate / 1000).toFixed(1) + ' kHz';
    setChip('chipAudio', 'Audio on', 'good');
    btn.textContent = 'Audio running';
    btn.classList.remove('primary');
    $('pluckBtn').disabled = false;
    $('release').disabled = false;
    $('resetModel').disabled = false;
    $('renderOffline').disabled = false;
    sendConfigure();
    updateControlLabels();
    toast('Audio running — pluck the string or press Space', 'good', 2600);
    pluckNow(0.6);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Start audio';
    setChip('chipAudio', 'Audio blocked', 'bad');
    toast('Could not start audio: ' + (err && err.message ? err.message : err), 'bad', 7000);
  }
}

$('startAudio').addEventListener('click', startAudio);

/* ───────────────────────────── mute / reset ─────────────────────────── */

function updateMuteButton() {
  const btn = $('release');
  btn.textContent = state.muted ? 'Unmute' : 'Mute';
  btn.classList.toggle('accent', state.muted);
}

$('release').addEventListener('click', () => {
  if (!state.started) return;
  state.muted = !state.muted;
  if (state.muted) {
    engine.release();
    scopeView.push(
      { delayed: 0, allpassOut: 0, loss2: 0, write: 0, out: 0 },
      performance.now() / 1000
    );
  } else {
    pluckNow(0.6);
  }
  updateMuteButton();
});

$('resetModel').addEventListener('click', () => {
  if (!state.started) return;
  state.faulted = false;
  state.muted = false;
  updateMuteButton();
  engine.reset();
  decayView.reset();
  partialView.set([], []);
  stopCapture();
  setChip('chipModel', 'Idle');
  setChip('chipStability', 'stable', 'good');
  sendConfigure();
});

$('resetDefaults').addEventListener('click', () => {
  setSlider('length', 0.64);
  setSlider('t60', 3);
  setSlider('damping', 0.088);
  $('dampingAuto').checked = true;
  controls.damping.disabled = true;
  setSlider('pluckPos', 0.18);
  setSlider('pickupPos', 0.52);
  setSlider('master', 0.6);
  updateControlLabels();
  updatePositions();
  onControlInput({ target: controls.length });
  sendConfigure();
});

/* ───────────────────────────── engine events ────────────────────────── */

engine.addEventListener('ready', (event) => {
  state.sampleRate = event.detail.contextRate || event.detail.sampleRate;
});

engine.addEventListener('state', (event) => {
  const data = event.detail;
  state.applied = data;
  state.lastAppliedParams = state.pendingParams;
  updateInternals(data);
  updateMetricsFromState(data);
  if (!state.faulted) {
    setChip('chipModel', data.state === 'ringing' ? 'Ringing' : data.state === 'excited' ? 'Excited' : 'Idle');
  }
});

engine.addEventListener('telemetry', (event) => {
  const data = event.detail;
  state.clipCount = data.clipCount || 0;
  updateInternalsLive(data);
  if (data.diverged) {
    setChip('chipStability', 'diverged', 'bad');
    setChip('chipModel', 'Fault', 'bad');
  } else if (!state.faulted && data.state && performance.now() >= state.chipHoldUntil) {
    // The model reports idle by itself once the loop is silent, so the chip
    // follows the real state rather than sticking at "Ringing".
    setChip('chipModel', data.state === 'ringing' ? 'Ringing' : data.state === 'excited' ? 'Excited' : 'Idle');
  }
});

engine.addEventListener('model-error', (event) => {
  const { message } = event.detail;
  toast(message, 'bad', 5200);
  setChip('chipModel', 'Rejected', 'bad');
  // Keep the rejection visible for a moment instead of letting the next
  // telemetry tick paint over it.
  state.chipHoldUntil = performance.now() + 2500;
  // Roll controls back to the last configuration the model accepted.
  if (state.lastAppliedParams) {
    const p = state.lastAppliedParams;
    if (p.lengthMeters !== undefined) {
      setSlider('length', p.lengthMeters);
      $('lengthOut').textContent = Number(controls.length.value).toFixed(3) + ' m';
    }
    if (p.t60 !== undefined) {
      setSlider('t60', p.t60);
      $('t60Out').textContent = Number(controls.t60.value).toFixed(1) + ' s';
    }
    if (p.damping !== null && p.damping !== undefined) {
      $('dampingAuto').checked = false;
      setSlider('damping', p.damping);
    }
    updateControlLabels();
    onControlInput({ target: controls.length });
    updatePositions();
  }
});

engine.addEventListener('fault', (event) => {
  state.faulted = true;
  setChip('chipStability', 'fault', 'bad');
  setChip('chipModel', 'Fault', 'bad');
  toast('Internal fault: ' + (event.detail && event.detail.message ? event.detail.message : 'loop diverged'), 'bad', 8000);
});

engine.addEventListener('excitation', (event) => {
  setChip('chipModel', 'Excited', 'good');
  decayView.reset();
  decayView.setPrediction(Number(controls.t60.value));
});

engine.addEventListener('reset', () => {
  scopeView.push({ delayed: 0, allpassOut: 0, loss2: 0, write: 0, out: 0 }, performance.now() / 1000);
});

/* ───────────────────────────── capture & analysis ───────────────────── */

function startCapture() {
  stopCapture();
  state.capture = { active: true, chunks: [], startedAt: performance.now() / 1000, needed: 0 };
  if (engine.node) {
    engine.node.port.postMessage({ type: 'capture', enabled: true, seconds: 1.9, chunk: 8192 });
  }
  // Fallback: if the worklet never answers, clear the waiting state.
  state.analysisTimer = setTimeout(() => {
    if (state.capture.active && state.capture.chunks.length === 0) {
      state.capture.active = false;
    }
  }, 3000);
}

function stopCapture() {
  clearTimeout(state.analysisTimer);
  state.capture.active = false;
  if (engine.node) engine.node.port.postMessage({ type: 'capture', enabled: false });
}

// Wire the capture channel directly (the engine forwards unknown messages).
engine.addEventListener('capture', (event) => {
  const { chunks, complete } = event.detail;
  if (!state.capture.active) return;
  state.capture.chunks.push(...chunks);
  if (complete) {
    state.capture.active = false;
    analyseCapture(state.capture.chunks, state.capture.startedAt);
  }
});

function analyseCapture(chunks, startedAt) {
  const totalLength = chunks.reduce((n, c) => n + c.length, 0);
  if (totalLength < 4096) return;
  const buffer = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const fs = state.sampleRate;
  const applied = state.applied;
  if (!applied) return;
  const frequency = applied.appliedFrequency || applied.requestedFrequency;
  const t60 = applied.requested ? applied.requested.t60 : 3;

  const pitchStart = Math.floor(fs * 0.12);
  const pitchLength = Math.min(Math.floor(fs * 0.5), buffer.length - pitchStart);
  if (pitchLength > 4096) {
    const measured = refineFrequency(buffer, frequency, fs, pitchStart, pitchLength, 100);
    const errorCents = cents(measured, frequency);
    setText('mPitch', measured.toFixed(2) + ' Hz');
    setText('mPitchErr', errorCents.toFixed(2) + ' cents', Math.abs(errorCents) < 1 ? 'good' : Math.abs(errorCents) < 5 ? 'warn' : 'bad');
    setText('refPitch', measured.toFixed(2) + ' Hz');
    setText('refPitchErr', errorCents.toFixed(2) + ' cents', Math.abs(errorCents) < 1 ? 'good' : 'warn');
  }

  // Decay: the live envelope is fed by telemetry.  This measured fit, taken
  // from the captured audio, fills the reference table.
  const decay = measureDecay(buffer, frequency, fs, {
    startSeconds: Math.min(0.15, t60 * 0.08),
    cyclesPerWindow: Math.max(8, Math.round(frequency / 6))
  });
  if (decay.reliable) {
    setText('refT60', decay.t60.toFixed(2) + ' s');
    setText('refT60Target', t60.toFixed(2) + ' s');
  }

  // Partials: measured 80–480 ms; predicted |sin(kπβ) sin(kπγ)| / k².
  const beta = applied.requested ? applied.requested.pluckPosition : Number(controls.pluckPos.value);
  const gamma = applied.requested ? applied.requested.pickupPosition : Number(controls.pickupPos.value);
  const partialStart = Math.floor(fs * 0.08);
  const partialLength = Math.min(Math.floor(fs * 0.4), buffer.length - partialStart);
  const measuredPartials = [];
  for (let k = 1; k <= 10; k++) {
    const f = frequency * k;
    if (f > fs * 0.45) break;
    measuredPartials.push(goertzel(buffer, f, fs, partialStart, partialLength));
  }
  const base = measuredPartials[0] || 1;
  const measuredNorm = measuredPartials.map(m => m / base);
  const predicted = [];
  for (let k = 1; k <= measuredNorm.length; k++) {
    predicted.push(Math.abs(Math.sin(k * Math.PI * beta) * Math.sin(k * Math.PI * gamma)) / (k * k));
  }
  const pbase = predicted[0] || 1;
  partialView.set(measuredNorm, predicted.map(p => p / pbase));

  setText('refPeak', peakOf(buffer).toFixed(3), peakOf(buffer) < 1 ? 'good' : 'warn');
  setText('refEnergy', totalEnergy(buffer).toFixed(3));
}

function goertzel(buffer, frequency, fs, start, length) {
  const w = 2 * Math.PI * frequency / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(buffer.length, start + length);
  for (let i = start; i < end; i++) {
    const s0 = buffer[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / ((end - start) / 2);
}

/* ───────────────────────────── internals ────────────────────────────── */

function updateInternals(data) {
  const f = data.appliedFrequency || 0;
  const target = data.targetDelay || 0;
  setText('oTarget', target.toFixed(4) + ' smp');
  setText('oNint', String(data.integerDelay ?? '—'));
  setText('oAp', Number(data.allpass ?? 0).toFixed(6));
  setText('oApDelay', Number(data.allpassDelay ?? 0).toFixed(4) + ' smp');
  setText('oLoss', Number(data.lossLambda ?? 0).toFixed(3) + ' / ' + Number(data.lossPhase ?? 0).toFixed(3));
  setText('oTotal', Number(data.totalDelay ?? 0).toFixed(4) + ' smp');
  const err = Math.abs(data.tuningErrorCents || 0);
  setText('oTune', err.toExponential(1) + ' c', err < 0.01 ? 'good' : err < 1 ? 'warn' : 'bad');
  const g = data.appliedGain ?? data.gain ?? 0;
  setText('oGain', g.toFixed(6));
  const marginDb = 20 * Math.log10(g || 1e-9);
  setText('oMargin', marginDb.toFixed(2) + ' dB', marginDb < -0.5 ? 'good' : 'warn');
  if (f > 0 && data.lossLambda !== undefined) {
    const fifth = predictedT60ForFrequency(5 * f, {
      sampleRate: state.sampleRate,
      lossLambda: data.lossLambda,
      frequency: f
    }, g);
    setText('oT60s', Number(data.predictedT60 ?? 0).toFixed(2) + ' / ' + fifth.toFixed(2) + ' s');
  }
  if (data.gainLimited) {
    setText('oGain', g.toFixed(6), 'warn');
    setChip('chipStability', 'T60 capped at g max', 'warn');
  } else if (!state.faulted) {
    setChip('chipStability', 'stable · g < 1', 'good');
  }
  setText('oPeak', Number(data.peak ?? 0).toFixed(4));
}

function updateInternalsLive(data) {
  const obs = data.observe;
  if (obs) {
    setText('vDelayed', obs.delayed.toExponential(2));
    setText('vAllpass', obs.allpassOut.toExponential(2));
    setText('vLoss', obs.loss2.toExponential(2));
    setText('vLooped', obs.looped.toExponential(2));
    setText('vWrite', obs.write.toExponential(2));
    setText('vOut', obs.out.toExponential(2));
    scopeView.push(obs, data.time || performance.now() / 1000);
  }
  setText('oTrips', String(data.trips ?? 0));
  if (data.peak !== undefined) {
    setText('oPeak', Number(data.peak).toFixed(4));
    setText('mPeak', Number(data.peak).toFixed(3), data.peak < 1 ? 'good' : 'warn');
  }
  if (data.clipCount) {
    setText('mClip', data.clipCount + ' clipped samples', 'warn');
  } else {
    setText('mClip', 'no clipping', 'good');
  }
  if (data.profile) stringView.setProfile(data.profile);
  if (data.rms !== undefined) decayView.pushLevel(data.time || performance.now() / 1000, data.rms);
}

function updateMetricsFromState(data) {
  const g = data.appliedGain ?? data.gain ?? 0;
  setText('mGain', g.toFixed(5));
  setText('mMargin', (20 * Math.log10(g || 1e-9)).toFixed(2) + ' dB');
  if (data.predictedT60 !== undefined) {
    setText('mPredT60', Number(data.predictedT60).toFixed(2) + ' s');
  }
  if (data.appliedFrequency) {
    const f = data.appliedFrequency;
    setChip('chipPitch', noteName(f) + ' · ' + f.toFixed(1) + ' Hz', 'good');
    if (data.tuningErrorCents !== undefined) {
      setText('oTune', Math.abs(data.tuningErrorCents).toExponential(1) + ' c', 'good');
    }
  }
}

/* ───────────────────────────── offline ──────────────────────────────── */

let lastWavUrl = null;

$('renderOffline').addEventListener('click', () => {
  const btn = $('renderOffline');
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  $('refStatus').textContent = 'Rendering with the current parameters…';
  setTimeout(() => {
    try {
      const dampingAuto = $('dampingAuto').checked;
      const config = {
        sampleRate: state.started ? state.sampleRate : 48000,
        frequency: frequencyForStringLength(Number(controls.length.value)),
        t60: Number(controls.t60.value),
        seconds: Number($('refSeconds').value),
        amplitude: 0.6,
        pluckPosition: Number(controls.pluckPos.value),
        pickupPosition: Number(controls.pickupPos.value),
        excitation: state.excitation,
        lossLambda: dampingAuto ? undefined : Number(controls.damping.value)
      };
      const { samples, report } = renderAndAnalyse(config);
      const wav = encodeWav(samples, config.sampleRate);
      if (lastWavUrl) URL.revokeObjectURL(lastWavUrl);
      lastWavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const link = $('downloadWav');
      link.href = lastWavUrl;
      link.download = 'taut-string-' + config.frequency.toFixed(1) + 'Hz.wav';
      link.classList.remove('disabled');
      link.setAttribute('aria-disabled', 'false');

      setText('refPitch', report.measuredFrequency.toFixed(2) + ' Hz');
      setText('refPitchTarget', report.requestedFrequency.toFixed(2) + ' Hz');
      const err = report.pitchErrorCents;
      setText('refPitchErr', err.toFixed(3) + ' cents', Math.abs(err) < 1 ? 'good' : 'warn');
      setText('refT60', report.measuredT60.toFixed(2) + ' s', report.t60Reliable ? 'good' : 'warn');
      setText('refT60Target', report.targetT60.toFixed(2) + ' s');
      setText('refPeak', report.peak.toFixed(3), report.peak < 1 ? 'good' : 'warn');
      setText('refEnergy', report.totalEnergy.toFixed(2));
      setText('refFinite', report.finite && !report.energyRises ? 'yes' : 'NO', report.finite && !report.energyRises ? 'good' : 'bad');

      setText('mPitch', report.measuredFrequency.toFixed(2) + ' Hz');
      setText('mPitchErr', err.toFixed(2) + ' cents', Math.abs(err) < 1 ? 'good' : 'warn');
      setText('mPredT60', report.predictedT60.toFixed(2) + ' s');
      setText('refStatus', 'Rendered ' + config.seconds + ' s · ' + config.sampleRate + ' Hz · measured from audio only.');
    } catch (err) {
      $('refStatus').textContent = 'Render failed: ' + (err.message || err);
      toast('Offline render failed: ' + (err.message || err), 'bad', 7000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Render & measure';
    }
  }, 30);
});

/* ─────────────────────── preset maintenance apply ───────────────────── */

/*
 * Apply a converted v2 preset to the live panel.  The actionable number is
 * the converted λ: the pitch control is set from the preset's frequency, and
 * the loss slider is taken off auto so the converted value actually reaches
 * the loop instead of being replaced by the auto curve.
 */
function applyConvertedPreset(applied, maintenance) {
  if (!applied) return;
  const length = stringLengthForFrequency(applied.frequency);
  setSlider('length', Math.min(1.8, Math.max(0.14, length)));
  setSlider('t60', applied.t60);
  $('dampingAuto').checked = false;
  setSlider('damping', applied.lambda);
  setSlider('pluckPos', applied.pluckPosition);
  setSlider('pickupPos', applied.pickupPosition);
  updateControlLabels();
  updatePositions();
  onControlInput({ target: controls.length });
  sendConfigure();
  highlightNotePreset();

  const carried = maintenance ? maintenance.convertedRelativeError : NaN;
  const rateMismatch = state.started && applied.sampleRate &&
    Math.abs(state.sampleRate - applied.sampleRate) > 1
    ? ' · fitted at ' + (applied.sampleRate / 1000).toFixed(1) + ' kHz, live at ' +
      (state.sampleRate / 1000).toFixed(1) + ' kHz'
    : '';
  toast('Applied ' + (maintenance ? maintenance.preset : 'preset') + ' with λ = ' +
    applied.lambda.toFixed(4) + ' (converted to reproduce the recording' +
    (Number.isFinite(carried) ? ', ' + (carried * 100).toFixed(1) + '% partial-5 error' : '') +
    ')' + rateMismatch,
    'good', 6000);
}

/* ───────────────────────────── boot ─────────────────────────────────── */

function boot() {
  buildNotePresets();
  updateControlLabels();
  updatePositions();
  highlightNotePreset();
  setChip('chipAudio', 'Audio off');
  setChip('chipModel', 'Idle');
  setChip('chipStability', 'stable');
  setChip('chipRate', (state.sampleRate / 1000).toFixed(1) + ' kHz');
  const f = frequencyForStringLength(Number(controls.length.value));
  $('factLength').textContent = Number(controls.length.value).toFixed(3);
  $('factPitch').textContent = noteName(f);
  $('factHz').textContent = f.toFixed(1);
  setChip('chipPitch', noteName(f) + ' · ' + f.toFixed(1) + ' Hz');
  $('chipPitch').dataset.tone = 'good';
  decayView.setPrediction(Number(controls.t60.value));
  controls.t60.addEventListener('input', () => {
    decayView.setPrediction(Number(controls.t60.value));
  });
  // Prime the internals table with a solved loop, even before audio starts.
  try {
    const sampleRate = 48000;
    const solved = solveLoop(f, sampleRate);
    updateInternals({
      ...solved,
      appliedFrequency: solved.frequency,
      appliedGain: loopGainForT60(f, Number(controls.t60.value), solved.lossLambda, { sampleRate }).gain,
      predictedT60: -3 / (Math.log10(loopGainForT60(f, Number(controls.t60.value), solved.lossLambda, { sampleRate }).gain) * f)
    });
  } catch (err) {
    // A pre-audio solve failure is only informational; the model itself is
    // untouched until audio starts.
  }
  window.__tautString = {
    engine,
    state,
    pluckNow,
    getLastApplied: () => state.applied
  };

  // Canvases redraw on data; also repaint after a resize while idle.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      stringView.draw();
      decayView.draw();
      partialView.draw();
      scopeView.draw();
    }, 120);
  });
}

boot();
initLibrary({ applyPreset: applyConvertedPreset }).catch((err) => {
  console.warn('example library unavailable:', err);
});
