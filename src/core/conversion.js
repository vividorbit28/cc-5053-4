/*
 * Legacy preset conversion: two-stage loss filter → single stage.
 *
 * Under kernel v2 the loop applied L(z)², so the loss magnitude at a partial
 * was raised to the second power and the loss phase was counted twice.  The
 * current kernel applies L(z) once.  A stored λ therefore no longer describes
 * the same sound, and carrying it forward is not a conversion.
 *
 * `convertLambda` picks the single-stage λ whose *predicted* partial T60
 * profile best matches the profile a legacy two-stage loop produced.
 * `fitLambdaToProfile` does the same against an arbitrary measured profile,
 * which is how the retained recordings are used: the target is what the old
 * sound measurably did, not what the old parameters claimed.
 *
 * Both report whether the single stage could actually reach the target.  It
 * cannot always: L² has twice the dB-per-round-trip of L at every partial, so
 * at high pitch the required λ exceeds the model's ceiling.
 */

import {
  loopGainForT60,
  loopLossMagnitude,
  TWO_PI,
  MAX_LOSS_LAMBDA
} from './string-model.js';

export function t60FromLoopGain(gain, frequency) {
  if (!(gain > 0) || !(gain < 1)) return Infinity;
  return -3 / (Math.log10(gain) * frequency);
}

function predictedT60(frequency, sampleRate, t60, lambda, stages, k) {
  const w = TWO_PI * frequency * k / sampleRate;
  const g = loopGainForT60(frequency, t60, lambda, { sampleRate, lossStages: stages }).gain;
  return -3 / (Math.log10(g * loopLossMagnitude(lambda, w, stages)) * frequency);
}

/*
 * Best single-stage λ for a pitch whose legacy loop used `lambdaOld` with
 * `oldStages`.  Matches the partial decay times over k = 1..harmonics in a
 * relative least-squares sense, so a short-lived high partial does not
 * dominate.  `limited` means no λ in range reproduces the profile.
 */
export function convertLambda(frequency, lambdaOld, oldStages = 2, sampleRate = 48000, harmonics = 8) {
  const target = [];
  for (let k = 1; k <= harmonics; k++) {
    target.push(predictedT60(frequency, sampleRate, 3, lambdaOld, oldStages, k));
  }
  return fitLambdaToTargets(frequency, sampleRate, 3, target.map((t60, i) => ({ k: i + 1, t60 })));
}

/*
 * Fit λ to a measured profile: `profile` is [{ k, t60 }] where t60 came from
 * audio, not from a parameter.  `tolerance` widens when the fit cannot get
 * close, so a legitimately unreachable target is reported rather than
 * mislabelled as a regression.
 */
export function fitLambdaToProfile(frequency, sampleRate, t60, profile) {
  return fitLambdaToTargets(frequency, sampleRate, t60, profile);
}

function fitLambdaToTargets(frequency, sampleRate, t60, profile) {
  if (!profile.length) {
    return { lambda: NaN, limited: true, relativeFitError: Infinity, acceptanceTolerance: Infinity };
  }
  let best = 0.06;
  let bestErr = Infinity;
  for (let lambda = 0.02; lambda <= MAX_LOSS_LAMBDA; lambda += 0.0005) {
    let err = 0;
    for (const p of profile) {
      const got = predictedT60(frequency, sampleRate, t60, lambda, 1, p.k);
      err += Math.pow((got - p.t60) / p.t60, 2);
    }
    if (err < bestErr) { bestErr = err; best = lambda; }
  }
  const relativeFitError = Math.sqrt(bestErr / profile.length);
  const atCeiling = best > MAX_LOSS_LAMBDA - 0.003 || relativeFitError > 0.05;
  return {
    lambda: Number(best.toFixed(4)),
    limited: atCeiling,
    relativeFitError,
    acceptanceTolerance: atCeiling ? Infinity : Math.max(0.03, relativeFitError + 0.02)
  };
}
