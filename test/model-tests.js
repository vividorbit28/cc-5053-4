/*
 * Model verification suite.
 *
 *   node test/model-tests.js
 *
 * Exercises the kernel directly (no browser) across pitch, string length and
 * damping configurations.  Each case checks one of the deliverable claims:
 *
 *   1. Frequency accuracy across the range, including high notes where a
 *      rounded buffer length would be audibly sharp.
 *   2. Decay curves: measured T60 vs. the requested T60 and the prediction.
 *   3. High partials decay faster than the fundamental (frequency-dependent
 *      loss), and the loss coefficient controls how much faster.
 *   4. Pluck and pickup positions move real modal nulls.
 *   5. Stability: loop gain always < 1, no NaN, no unbounded growth, and
 *      out-of-range requests are rejected rather than bent.
 *   6. Energy is positive and monotonically decreasing after excitation.
 */

import { StringModel, solveLoop, loopGainForT60, predictedT60ForFrequency, frequencyForStringLength, stringLengthForFrequency, modalWeight, ModelError, MAX_LOOP_GAIN } from '../src/core/string-model.js';
import { refineFrequency, cents, measureDecay, measurePartialDecay, totalEnergy, blockEnergy, smoothEnvelope, peakOf } from '../src/core/analysis.js';
import { renderAndAnalyse } from '../src/core/offline.js';

const results = [];
let failed = 0;

function assert(ok, label, detail = '') {
  results.push({ ok, label, detail });
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
}

function near(value, target, tol) {
  return Number.isFinite(value) && Math.abs(value - target) <= tol;
}

/* ─── 1. Tuning across pitch and sample rate ─────────────────────────── */

console.log('\n== Tuning precision ==');
const pitches = [41.2, 55, 82.41, 110, 146.83, 196, 220, 329.63, 440, 659.26, 880, 1046.5, 1318.5, 1760, 2093];
for (const sampleRate of [44100, 48000]) {
  let worst = 0;
  let worstPitch = 0;
  for (const f of pitches) {
    const s = solveLoop(f, sampleRate);
    const measuredDelay = s.integerDelay + s.allpassDelay + s.lossPhase;
    const errCents = Math.abs(cents(measuredDelay, s.targetDelay));
    if (errCents > worst) { worst = errCents; worstPitch = f; }
    assert(errCents < 1e-6,
      `solve ${f.toFixed(2)} Hz @ ${sampleRate}: loop phase delay exactly matches period`,
      errCents.toExponential(1) + ' cents');
  }
  assert(worst < 1e-6, `all pitches @ ${sampleRate} within 1e-6 cent`, `worst ${worstPitch} Hz`);
}

// The naive alternative (rounding the buffer length) is audibly wrong at high
// pitch; quantify that so the claim is measurable.
console.log('\n== Why fractional delay matters ==');
for (const f of [440, 880, 1318.5, 2093]) {
  const sampleRate = 48000;
  const truePeriod = sampleRate / f;
  const roundedPeriod = Math.round(truePeriod);
  const naiveCents = 1200 * Math.log2(roundedPeriod / truePeriod);
  assert(Math.abs(naiveCents) > 1.2,
    `rounded-buffer tuning error at ${f} Hz is audible`,
    Math.abs(naiveCents).toFixed(1) + ' cents');
}

/* ─── 2. Rendered pitch accuracy ─────────────────────────────────────── */

console.log('\n== Rendered pitch accuracy ==');
const renderCases = [
  { frequency: 82.41, t60: 4 },
  { frequency: 110, t60: 2.5 },
  { frequency: 220, t60: 3 },
  { frequency: 440, t60: 1.5 },
  { frequency: 880, t60: 0.9 },
  { frequency: 1318.5, t60: 0.6 }
];
const rendered = [];
for (const { frequency, t60 } of renderCases) {
  const { samples, report, solved } = renderAndAnalyse({
    frequency, t60, seconds: 3, amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52
  });
  rendered.push({ ...report, samples, solved });
  assert(Math.abs(report.pitchErrorCents) < 1,
    `rendered f0 ${frequency} Hz within 1 cent`,
    report.measuredFrequency.toFixed(3) + ' Hz, ' + report.pitchErrorCents.toFixed(3) + ' cents');
  assert(report.finite, `rendered ${frequency} Hz audio is finite`);
}

/* ─── 3. Decay accuracy ──────────────────────────────────────────────── */

console.log('\n== Decay (T60) ==');
for (const r of rendered) {
  const target = r.targetT60;
  assert(r.t60Reliable, `T60 measurement at ${r.requestedFrequency} Hz is reliable`);
  assert(near(r.measuredT60, target, Math.max(0.12, target * 0.06)),
    `measured T60 matches target at ${r.requestedFrequency} Hz`,
    'measured ' + r.measuredT60.toFixed(3) + ' s, target ' + target + ' s');
  assert(near(r.measuredT60, r.predictedT60, Math.max(0.12, target * 0.06)),
    `measured T60 matches prediction at ${r.requestedFrequency} Hz`,
    'predicted ' + r.predictedT60.toFixed(3) + ' s');
}

// Different T60 configs at one pitch.
console.log('\n== T60 configurations ==');
for (const t60 of [0.4, 1, 2, 4, 8]) {
  const { report } = renderAndAnalyse({ frequency: 220, t60, seconds: Math.min(12, t60 * 1.4 + 1) });
  assert(report.t60Reliable && near(report.measuredT60, t60, Math.max(0.1, t60 * 0.07)),
    `T60 ${t60}s measured`,
    report.measuredT60.toFixed(3) + ' s');
}

/* ─── 4. Frequency-dependent loss ────────────────────────────────────── */

console.log('\n== Frequency-dependent damping ==');
function renderAt(frequency, t60, lossLambda, seconds = 2.5) {
  return renderAndAnalyse({ frequency, t60, lossLambda, seconds, amplitude: 0.6 });
}
{
  const f0 = 220;
  const bright = renderAt(f0, 3, 0.06, 3);
  const dull = renderAt(f0, 3, 0.30, 3);
  const brightPartial5 = measurePartialDecay(bright.samples, f0 * 5, 48000, { startSeconds: 0.05, windowSeconds: 0.2 });
  const dullPartial5 = measurePartialDecay(dull.samples, f0 * 5, 48000, { startSeconds: 0.05, windowSeconds: 0.2 });
  assert(brightPartial5.t60 < bright.report.measuredT60 * 0.97,
    'with λ=0.06 the 5th partial decays faster than f0',
    'f0 ' + bright.report.measuredT60.toFixed(2) + ' s vs 5th ' + brightPartial5.t60.toFixed(2) + ' s');
  assert(dullPartial5.t60 < brightPartial5.t60 * 0.97,
    'larger λ dampens the 5th partial faster (frequency-dependent loss)',
    'λ0.06 → ' + brightPartial5.t60.toFixed(2) + ' s, λ0.30 → ' + dullPartial5.t60.toFixed(2) + ' s');
  // The model's own prediction for the same partial should match the render.
  const predicted5 = predictedT60ForFrequency(f0 * 5, solveLoop(f0, 48000, { lossLambda: 0.06 }), bright.solved.gain);
  const predicted5dull = predictedT60ForFrequency(f0 * 5, solveLoop(f0, 48000, { lossLambda: 0.30 }), dull.solved.gain);
  assert(Math.abs(brightPartial5.t60 - predicted5) < predicted5 * 0.12,
    'measured 5th-partial T60 matches loop prediction (λ=0.06)',
    brightPartial5.t60.toFixed(2) + ' vs ' + predicted5.toFixed(2) + ' s');
  assert(Math.abs(dullPartial5.t60 - predicted5dull) < predicted5dull * 0.12,
    'measured 5th-partial T60 matches loop prediction (λ=0.30)',
    dullPartial5.t60.toFixed(2) + ' vs ' + predicted5dull.toFixed(2) + ' s');
}

/* ─── 5. Pluck and pickup position modal nulls ───────────────────────── */

console.log('\n== Pluck / pickup positions ==');
function earlyPartialRatios(samples, f0, fs, count = 8, t0 = 0.004, t1 = 0.05) {
  const start = Math.floor(t0 * fs);
  const length = Math.floor((t1 - t0) * fs);
  const mags = [];
  for (let k = 1; k <= count; k++) {
    const f = f0 * k;
    if (f >= fs / 2) break;
    const w = 2 * Math.PI * f / fs;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = start; i < start + length; i++) {
      const s0 = samples[i] + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    mags.push(Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / (length / 2));
  }
  const base = mags[0] || 1;
  return mags.map(m => m / base);
}

{
  // Pickup exactly at the midpoint nulls even harmonics.
  const mid = renderAndAnalyse({
    frequency: 220, t60: 8, seconds: 1, pluckPosition: 0.25, pickupPosition: 0.5, lossLambda: 0.02
  });
  const ratios = earlyPartialRatios(mid.samples, 220, 48000, 8);
  const evenSum = ratios[1] + ratios[3] + ratios[5] + ratios[7];
  const oddSum = ratios[2] + ratios[4] + ratios[6];
  assert(evenSum < oddSum * 0.35,
    'pickup at 50% suppresses even harmonics',
    'even ' + evenSum.toFixed(3) + ' vs odd ' + oddSum.toFixed(3));

  // Pluck at 1/5 should null the 5th partial.
  const fifthPluck = renderAndAnalyse({
    frequency: 220, t60: 8, seconds: 1, pluckPosition: 0.2, pickupPosition: 0.83, lossLambda: 0.02
  });
  const r5 = earlyPartialRatios(fifthPluck.samples, 220, 48000, 6);
  assert(r5[4] < r5[2] * 0.2,
    'plucking at 20% suppresses the 5th partial relative to the 3rd',
    'p3 ' + r5[2].toFixed(3) + ', p5 ' + r5[4].toFixed(4));

  // Moving the pickup from 50% should restore even harmonics.
  const off = renderAndAnalyse({
    frequency: 220, t60: 8, seconds: 1, pluckPosition: 0.25, pickupPosition: 0.33, lossLambda: 0.02
  });
  const rOff = earlyPartialRatios(off.samples, 220, 48000, 8);
  assert(rOff[1] > ratios[1] * 3,
    'moving the pickup off 50% restores the 2nd partial',
    'γ0.50 ' + ratios[1].toFixed(4) + ' → γ0.33 ' + rOff[1].toFixed(3));

  // Analytic weights track the measured pattern (correlation on 8 partials).
  for (const [b, g] of [[0.18, 0.52], [0.2, 0.83], [0.33, 0.33]]) {
    const res = renderAndAnalyse({
      frequency: 220, t60: 8, seconds: 1, pluckPosition: b, pickupPosition: g, lossLambda: 0.02
    });
    const measured = earlyPartialRatios(res.samples, 220, 48000, 8);
    const predicted = measured.map((_, i) => {
      const k = i + 1;
      return Math.abs(Math.sin(k * Math.PI * b) * Math.sin(k * Math.PI * g)) / (k * k);
    });
    const pBase = predicted[0] || 1;
    const normalized = predicted.map(p => p / pBase);
    const corr = correlation(measured, normalized);
    assert(corr > 0.9,
      `measured partials match the position model (β=${b}, γ=${g})`,
      'r = ' + corr.toFixed(3));
  }
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

/* ─── 6. Energy behaviour ────────────────────────────────────────────── */

console.log('\n== Energy ==');
for (const r of rendered) {
  const energies = smoothEnvelope(r.samples, 48000, 20, 6);
  const peakIndex = energies.indexOf(Math.max(...energies));
  let monotoneAfter = true;
  for (let i = peakIndex + 2; i < energies.length; i++) {
    if (energies[i] > energies[i - 1] * 1.02 + 1e-9) { monotoneAfter = false; break; }
  }
  assert(monotoneAfter, `energy decays monotonically after attack at ${r.requestedFrequency} Hz`);
  assert(r.totalEnergy > 0, `total energy positive at ${r.requestedFrequency} Hz`,
    r.totalEnergy.toFixed(2));
}

/* ─── 7. String length mapping ───────────────────────────────────────── */

console.log('\n== String length ↔ pitch ==');
for (const [lengthMeters, expected] of [[0.64, 220], [0.32, 440], [1.28, 110], [0.28, 502.857]]) {
  const f = frequencyForStringLength(lengthMeters);
  assert(near(f, expected, 0.01),
    `length ${lengthMeters} m → ${expected} Hz`, f.toFixed(3) + ' Hz');
  assert(near(stringLengthForFrequency(f), lengthMeters, 1e-9),
    `round-trip length for ${expected} Hz`);
}

/* ─── 8. Stability and rejection ─────────────────────────────────────── */

console.log('\n== Stability ==');
{
  // Gain for an extreme T60 must be capped below 1.
  for (const [f, t60] of [[880, 60], [220, 60], [41.2, 60], [3520, 30]]) {
    const s = solveLoop(f, 48000);
    const g = loopGainForT60(f, t60, s.lossLambda, { sampleRate: 48000 });
    assert(g.gain < 1 && g.gain <= MAX_LOOP_GAIN,
      `gain stays below 1 for T60=${t60}s at ${f} Hz`,
      'g=' + g.gain.toFixed(6) + ', required=' + g.required.toFixed(6));
  }

  // Run a long, high-gain render: no growth, no NaN.
  const extreme = renderAndAnalyse({ frequency: 1318.5, t60: 30, seconds: 8, amplitude: 0.9 });
  assert(extreme.report.finite, 'T60=30s far above MAX_LOOP_GAIN render stays finite');
  assert(!extreme.report.energyRises, 'no late energy growth at capped gain');
  assert(extreme.report.peak < 1, 'peak under output limit at capped gain',
    extreme.report.peak.toFixed(3));

  // Rejections.
  const bad = [
    () => solveLoop(30000, 48000),
    () => solveLoop(10, 48000),
    () => solveLoop(NaN, 48000),
    () => solveLoop(220, 48000, { lossLambda: 0.9 }),
    () => loopGainForT60(220, -1, 0.1, { sampleRate: 48000 })
  ];
  for (const fn of bad) {
    let threw = false;
    try { fn(); } catch (err) { threw = err instanceof ModelError; }
    assert(threw, 'invalid request rejected with ModelError', fn.toString().slice(0, 46));
  }

  // Model-level rejection should not leave the loop broken: configure again
  // and it should still produce sound.
  const m = new StringModel(48000);
  m.configure({ frequency: 220, t60: 3 });
  let rejected = false;
  try { m.configure({ frequency: 40000, t60: 3 }); } catch { rejected = true; }
  m.configure({ frequency: 220, t60: 3 });
  m.pluck(0.6);
  let peak = 0;
  for (let i = 0; i < 24000; i++) peak = Math.max(peak, Math.abs(m.tick()));
  assert(rejected && peak > 0.01,
    'model stays playable after a rejected configuration', 'peak ' + peak.toFixed(3));
}

/* ─── 9. Param sweeps: continuous adjustment stays stable ────────────── */

console.log('\n== Continuous adjustment ==');
{
  const m = new StringModel(48000);
  m.configure({ frequency: 220, t60: 3 });
  m.pluck(0.7);
  let peak = 0;
  let finite = true;
  // Sweep the length smoothly for 6 seconds at 48 kHz, while ringing.
  for (let i = 0; i < 48000 * 6; i++) {
    if (i % 256 === 0) {
      const t = i / (48000 * 6);
      const length = 0.28 + t * 1.1;          // 0.28 m → 1.38 m
      const t60 = 0.4 + t * 10;               // 0.4 s → 10.4 s
      const lambda = 0.03 + t * 0.35;
      try {
        m.configure({ frequency: frequencyForStringLength(length), t60, lossLambda: lambda });
      } catch (err) { finite = false; }
    }
    const v = m.tick();
    if (!Number.isFinite(v)) finite = false;
    peak = Math.max(peak, Math.abs(v));
  }
  assert(finite, 'continuous length/T60/λ sweep produces finite samples');
  assert(peak < 2, 'continuous sweep never exceeds bounded output', 'peak ' + peak.toFixed(3));
  assert(!m.diverged, 'watchdog never reports divergence during sweep');
}

/* ─── 10. Excitation is not a sample ─────────────────────────────────── */

console.log('\n== Excitation type ==');
{
  const s = solveLoop(220, 48000);
  const excitationMs = 1000 * s.integerDelay / 48000;
  assert(excitationMs < 20,
    'pluck excitation lasts one round trip (short compared with sustain)',
    excitationMs.toFixed(2) + ' ms');
  const sustain = renderAndAnalyse({ frequency: 220, t60: 3, seconds: 3 });
  const energy = blockEnergy(sustain.samples, 48000, 10);
  let nonzeroAfter500ms = 0;
  const after = Math.floor(energy.length * 0.17);
  for (let i = after; i < energy.length; i++) if (energy[i] > 1e-8) nonzeroAfter500ms++;
  assert(nonzeroAfter500ms > energy.length * 0.3,
    'sound continues long after the excitation (' + excitationMs.toFixed(1) + ' ms) ends',
    nonzeroAfter500ms + ' blocks active');
}

/* ─── summary ────────────────────────────────────────────────────────── */

console.log('\n' + '='.repeat(60));
console.log(failed === 0
  ? `All ${results.length} model checks passed`
  : `${failed} of ${results.length} model checks FAILED`);
process.exit(failed ? 1 : 0);
