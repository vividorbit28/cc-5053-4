/*
 * Offline renderer and reference measurement suite.
 *
 * Renders a pluck from the same StringModel the realtime worklet uses, so
 * the offline reference and live output are the same signal path.  Produces:
 *
 *   - a WAV file of the plucked note
 *   - a JSON report: measured f0 in cents, measured T60, predicted T60,
 *     peak sample, total energy, modal amplitudes for pluck/pickup positions,
 *     and stability checks on the loop.
 */

import { StringModel, solveLoop, loopGainForT60, frequencyForStringLength, stringLengthForFrequency } from './string-model.js';
import { refineFrequency, cents, measureDecay, totalEnergy, peakOf, blockEnergy } from './analysis.js';

export const DEFAULT_RENDER = {
  sampleRate: 48000,
  frequency: 220,
  t60: 3,
  seconds: 5,
  amplitude: 0.6,
  pluckPosition: 0.18,
  pickupPosition: 0.52,
  excitation: 'pluck'
};

export function renderString(config = {}) {
  const cfg = { ...DEFAULT_RENDER, ...config };
  const model = new StringModel(cfg.sampleRate);
  const solved = model.configure({
    frequency: cfg.frequency,
    t60: cfg.t60,
    lossLambda: cfg.lossLambda,
    pluckPosition: cfg.pluckPosition,
    pickupPosition: cfg.pickupPosition
  });
  if (cfg.excitation === 'burst') model.burst(cfg.amplitude, 2.5, cfg.pluckPosition);
  else model.pluck(cfg.amplitude, cfg.pluckPosition);
  const samples = new Float32Array(Math.round(cfg.seconds * cfg.sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = model.tick();
  return { samples, solved, model, cfg };
}

export function analyseRender(samples, sampleRate, frequency, t60Target, solved, extra = {}) {
  const windowStart = Math.floor(Math.min(0.25, t60Target * 0.2) * sampleRate);
  const windowLength = Math.min(32768, samples.length - windowStart);
  const pitch = refineFrequency(samples, frequency, sampleRate, windowStart, windowLength, 80);
  const decay = measureDecay(samples, frequency, sampleRate, {
    startSeconds: Math.min(0.1, t60Target * 0.1),
    expectedT60: t60Target
  });
  let nonFinite = 0;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) nonFinite++;
  }
  const energies = blockEnergy(samples, sampleRate, 10);
  const maxEnergy = Math.max(...energies);
  let divergence = false;
  for (const e of energies) if (e > maxEnergy * 1.5 && e > 1e-6) divergence = true;
  const peak = peakOf(samples);
  return {
    requestedFrequency: frequency,
    measuredFrequency: pitch,
    pitchErrorCents: cents(pitch, frequency),
    targetT60: t60Target,
    predictedT60: extra.predictedT60,
    measuredT60: decay.t60,
    t60Reliable: decay.reliable,
    peak,
    finite: nonFinite === 0,
    maxBlockEnergy: maxEnergy,
    energyRises: divergence,
    totalEnergy: totalEnergy(samples),
    solved,
    ...extra
  };
}

export function renderAndAnalyse(config = {}) {
  const { samples, solved, model, cfg } = renderString(config);
  const report = analyseRender(samples, cfg.sampleRate, cfg.frequency, cfg.t60, solved, {
    predictedT60: model.snapshot().predictedT60,
    gain: solved.gain,
    gainLimited: solved.gainLimited,
    integerDelay: solved.integerDelay,
    allpass: solved.allpass,
    allpassDelay: solved.allpassDelay,
    lossLambda: solved.lossLambda,
    stringLength: stringLengthForFrequency(cfg.frequency),
    pluckPosition: model.pluckPosition,
    pickupPosition: model.pickupPosition,
    diverged: model.diverged
  });
  return { samples, report, model, cfg, solved };
}

/*
 * Partial amplitudes (magnitudes relative to the fundamental) measured from
 * the beginning of the steady portion by Goertzel at k·f0.  Used to verify
 * that pluck/pickup positions create the predicted modal nulls.
 */
export function partialRatioMeasurement(samples, sampleRate, frequency, count = 8) {
  const start = Math.floor(sampleRate * 0.06);
  const length = Math.min(Math.round(sampleRate * 0.4), samples.length - start);
  const mags = [];
  for (let k = 1; k <= count; k++) {
    const f = frequency * k;
    if (f >= sampleRate / 2) break;
    const w = 2 * Math.PI * f / sampleRate;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < start + length; i++) {
      const s0 = samples[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    mags.push(Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / (length / 2));
  }
  const fundamental = mags[0] || 1;
  return mags.map(m => m / fundamental);
}

/* ───────────────────────── WAV writing ───────────────────────── */

export function encodeWav(samples, sampleRate, channels = 1) {
  if (channels !== 1) throw new Error('only mono WAV is supported');
  const length = samples.length;
  const bytesPerSample = 2;
  const dataBytes = length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}
