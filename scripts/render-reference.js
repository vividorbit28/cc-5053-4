/*
 * Offline reference renderer (command line).
 *
 *   node scripts/render-reference.js [--f 220] [--t60 3] [--seconds 5]
 *                                     [--length 0.64] [--lambda 0.088]
 *                                     [--pluck 0.18] [--pickup 0.52]
 *                                     [--burst] [--out output/reference]
 *
 * Writes <out>.wav and <out>.json.  The JSON contains the measured f0, T60,
 * partial decay times, peak, energy, and the full solved loop parameters.
 * This is the same kernel the browser uses; it exists so the model can be
 * checked and auditioned without a browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderAndAnalyse,
  encodeWav,
  partialRatioMeasurement
} from '../src/core/offline.js';
import {
  frequencyForStringLength,
  stringLengthForFrequency,
  solveLoop,
  predictedT60ForFrequency,
  modalWeight
} from '../src/core/string-model.js';
import { measurePartialDecay, peakOf, totalEnergy } from '../src/core/analysis.js';

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
}
function num(name, fallback) {
  const v = flag(name);
  return v === null || v === true ? fallback : Number(v);
}

const sampleRate = num('rate', 48000);
const lengthMeters = flag('length') ? num('length', 0.64) : null;
const frequency = flag('f') ? num('f', 220) : lengthMeters ? frequencyForStringLength(lengthMeters) : 220;
const outBase = typeof flag('out') === 'string' ? flag('out') : 'output/reference';
const config = {
  sampleRate,
  frequency,
  t60: num('t60', 3),
  seconds: num('seconds', 5),
  amplitude: num('amp', 0.6),
  pluckPosition: num('pluck', 0.18),
  pickupPosition: num('pickup', 0.52),
  excitation: flag('burst') ? 'burst' : 'pluck',
  lossLambda: flag('lambda') ? num('lambda', 0.088) : undefined
};

const { samples, report, solved, model } = renderAndAnalyse(config);

// Per-partial decay, measured from the audio and predicted from the loop.
const partials = [];
for (let k = 1; k <= 8; k++) {
  const f = frequency * k;
  if (f >= sampleRate * 0.45) break;
  const measured = measurePartialDecay(samples, f, sampleRate, { startSeconds: 0.05, windowSeconds: 0.16 });
  const predicted = predictedT60ForFrequency(f, solved, solved.gain);
  partials.push({
    harmonic: k,
    frequency: f,
    measuredT60: measured.t60,
    predictedT60: predicted,
    predictedAmplitude: modalWeight(k, config.pluckPosition, config.pickupPosition)
  });
}

const json = {
  config,
  stringLength: stringLengthForFrequency(frequency),
  solved: {
    frequency: solved.frequency,
    targetDelaySamples: solved.targetDelay,
    integerDelay: solved.integerDelay,
    allpassCoefficient: solved.allpass,
    allpassPhaseDelay: solved.allpassDelay,
    lossPhaseDelayPerStage: solved.lossPhase / 2,
    lossLambda: solved.lossLambda,
    totalDelaySamples: solved.totalDelay,
    tuningErrorCents: solved.tuningErrorCents,
    loopGain: solved.gain,
    gainLimited: solved.gainLimited
  },
  measured: {
    f0: report.measuredFrequency,
    pitchErrorCents: report.pitchErrorCents,
    t60: report.measuredT60,
    t60Reliable: report.t60Reliable,
    peak: report.peak,
    finite: report.finite,
    energyMonotone: !report.energyRises,
    totalEnergy: report.totalEnergy
  },
  partials,
  partialRatiosMeasured: partialRatioMeasurement(samples, sampleRate, frequency, 8),
  supportedMechanisms: [
    'single lossy dispersive delay-loop string',
    'exact harmonic tuning including fractional delay and loss-filter phase',
    'frequency-dependent decay via two one-zero lowpass stages',
    'pluck-position and pickup-position modal weighting'
  ],
  notModelled: [
    'string-to-string coupling', 'body resonances', 'nonlinear tension',
    'sympathetic strings', 'spatial radiation'
  ]
};

const wav = encodeWav(samples, sampleRate);
const outDir = path.dirname(outBase);
if (outDir && outDir !== '.') fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outBase + '.wav', wav);
fs.writeFileSync(outBase + '.json', JSON.stringify(json, null, 2));

console.log('Rendered ' + config.seconds + ' s at ' + sampleRate + ' Hz');
console.log('Pitch:      ' + report.measuredFrequency.toFixed(3) + ' Hz (' +
  report.pitchErrorCents.toFixed(3) + ' cents from ' + frequency.toFixed(3) + ' Hz)');
console.log('T60:        ' + report.measuredT60.toFixed(3) + ' s (target ' + config.t60 + ' s)');
console.log('Peak:       ' + report.peak.toFixed(3) + '   energy ' + report.totalEnergy.toFixed(2));
console.log('Loop:       N=' + solved.integerDelay + '  a=' + solved.allpass.toFixed(6) +
  '  λ=' + solved.lossLambda.toFixed(4) + '  g=' + solved.gain.toFixed(6));
console.log('Tuning err: ' + solved.tuningErrorCents.toExponential(2) + ' cents');
console.log('Partial T60 (measured vs predicted):');
for (const p of partials) {
  console.log('  k=' + p.harmonic + '  ' + p.frequency.toFixed(1) + ' Hz  ' +
    p.measuredT60.toFixed(2) + ' s vs ' + p.predictedT60.toFixed(2) + ' s');
}
console.log('Wrote ' + outBase + '.wav and ' + outBase + '.json');
