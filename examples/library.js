/*
 * Executable tuning-example library.
 *
 * Every case is a set of parameters plus a set of *measurable targets*: the
 * base period in samples and the decay time (T60) demanded of named partials.
 * Nothing here is a "looks right" fixture.  `generate-examples.js` renders
 * each case from the kernel, measures the pitch by phase slope and each
 * partial's T60 by windowed regression, and either records the measured value
 * or records the case as indeterminate with the reason.  If a kernel change
 * moves a measured value outside its declared tolerance, generation fails
 * rather than quietly rewriting the target.
 *
 * Two pairs are the point of the exercise:
 *
 *   PAIR 1 — same nominal f0, different decay.
 *     A and B are tuned to the same 220 Hz.  A uses the auto λ; B uses a much
 *     larger λ, so its partials die faster while its base period is
 *     unchanged.  This pair separates "pitch" from "brightness": they differ
 *     measurably in T60(k) and not measurably in period.
 *
 *   PAIR 2 — closely matched fundamental T60, different measured pitch.
 *     C and D are two nearby pitches whose fundamental T60s are within a few
 *     percent, yet their base periods differ by nearly a semitone.  This pair
 *     is the trap for an analysis that infers pitch from decay: equal tails
 *     do not mean equal pitch.
 *
 * Both pairs also exercise the two ways a non-integer period can move the
 * actual pitch: the fractional-delay allpass coefficient, and the loss
 * filter's own phase delay.  Case `loss-phase-drift` holds N and the allpass
 * coefficient fixed and changes only λ, so the measured period moves even
 * though the "pitch control" was never touched.
 */

export const LIBRARY_VERSION = 3;

/*
 * A sample is fully determined by `config` (what the renderer consumes) and
 * `targets` (what the measurement must show).  `tolerance` is in the units
 * named by the target; generation fails outside it.
 */
export const EXAMPLES = [
  {
    id: 'pair-a-same-pitch-bright',
    pair: 'same-f0-different-decay',
    role: 'A',
    note: 'A3, auto damping — reference member of the pitch-identical pair',
    config: {
      sampleRate: 48000, frequency: 220, t60: 3.0, seconds: 4.0,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      periodSamples: { value: 218.1818, tolerance: 0.02 },
      partialT60: {
        1: { value: 3.0, tolerance: 0.10 },
        2: { value: 2.94, tolerance: 0.10 },
        4: { value: 2.74, tolerance: 0.10 },
        5: { value: 2.60, tolerance: 0.10 }
      }
    }
  },
  {
    id: 'pair-b-same-pitch-dull',
    pair: 'same-f0-different-decay',
    role: 'B',
    note: 'A3, λ=0.40 — same period as A, partials die much sooner',
    config: {
      sampleRate: 48000, frequency: 220, t60: 3.0, seconds: 4.0,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: 0.40
    },
    targets: {
      periodSamples: { value: 218.1818, tolerance: 0.02 },
      partialT60: {
        1: { value: 3.0, tolerance: 0.10 },
        2: { value: 2.92, tolerance: 0.10 },
        4: { value: 2.625, tolerance: 0.10 },
        5: { value: 2.442, tolerance: 0.10 }
      }
    }
  },
  {
    id: 'pair-c-tail-matched-low',
    pair: 'matched-tail-different-pitch',
    role: 'C',
    note: 'G3-ish (196.0 Hz), 1.52 s fundamental tail',
    config: {
      sampleRate: 48000, frequency: 196.0, t60: 1.52, seconds: 2.2,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      periodSamples: { value: 48000 / 196.0, tolerance: 0.02 },
      partialT60: {
        1: { value: 1.52, tolerance: 0.08 },
        5: { value: 1.443, tolerance: 0.08 }
      }
    }
  },
  {
    id: 'pair-d-tail-matched-high',
    pair: 'matched-tail-different-pitch',
    role: 'D',
    note: 'B3-ish (246.94 Hz), 1.47 s fundamental tail — same tail, a major third higher',
    config: {
      sampleRate: 48000, frequency: 246.94, t60: 1.47, seconds: 2.2,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      periodSamples: { value: 48000 / 246.94, tolerance: 0.02 },
      partialT60: {
        1: { value: 1.47, tolerance: 0.08 },
        5: { value: 1.321, tolerance: 0.08 }
      }
    }
  },
  {
    id: 'loss-phase-drift',
    pair: 'loss-phase-changes-pitch',
    role: 'single',
    note: 'N and allpass fixed; only λ changes. The measured period moves.',
    config: {
      sampleRate: 48000, frequency: 220, t60: 3.0, seconds: 3.5,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: 0.05,
      // Generation renders this case twice: once at the config's λ and once
      // with lossLambdaOverride, holding N and the allpass coefficient fixed.
      lossLambdaOverride: 0.40
    },
    targets: {
      // The rendered λ=0.05 member is exactly tuned; the λ=0.40 member is
      // deliberately off by the loss filter's extra phase.
      periodSamples: { value: 218.1818, tolerance: 0.02 },
      pitchShiftCents: { value: -2.77, tolerance: 0.5 }
    }
  },
  {
    id: 'short-tail-indeterminate',
    pair: null,
    role: 'single',
    note: 'A fast, quiet capture with too little tail: generation must keep it as indeterminate',
    config: {
      sampleRate: 48000, frequency: 82.41, t60: 0.2, seconds: 0.5,
      amplitude: 0.35, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      // Deliberately no period target: this case exists to prove that the
      // generator refuses to stamp a number on a tail it cannot fit.
      expectIndeterminate: true,
      minFitSpanSeconds: 0.2
    }
  },
  {
    id: 'rate-boundary-44k1',
    pair: 'nominal-pitch-across-rates',
    role: '44100',
    note: 'B2 (123.47 Hz) at 44.1 kHz — integer delay is within 0.01 sample of stepping',
    config: {
      sampleRate: 44100, frequency: 123.47, t60: 2.5, seconds: 3.5,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      periodSamples: { value: 44100 / 123.47, tolerance: 0.02 },
      integerDelay: { value: 356, tolerance: 0 },
      // distance from the allpass-range edge, in samples; the generator
      // reports it so "near the boundary" is a measured quantity, not prose.
      boundaryDistance: { value: 0.0073, tolerance: 0.01 }
    }
  },
  {
    id: 'rate-boundary-48k',
    pair: 'nominal-pitch-across-rates',
    role: '48000',
    note: 'B2 (123.47 Hz) at 48 kHz — same nominal pitch, comfortable fractional delay',
    config: {
      sampleRate: 48000, frequency: 123.47, t60: 2.5, seconds: 3.5,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: null
    },
    targets: {
      periodSamples: { value: 48000 / 123.47, tolerance: 0.02 },
      integerDelay: { value: 388, tolerance: 0 },
      boundaryDistance: { value: 0.4207, tolerance: 0.01 }
    }
  }
];

/*
 * Legacy preset captured under kernel v2 (two loss stages).  It is kept
 * verbatim in the library so the maintenance panel can show what carrying the
 * old numbers forward does under the current filter, and so the conversion
 * can be checked against a recording of the old sound rather than a guess.
 */
export const LEGACY_PRESETS = [
  {
    id: 'legacy-a3-v2',
    label: 'A3 (v2 loop, L²)',
    kernel: 2,
    lossStages: 2,
    note: 'Saved before the loss filter became single-stage. Kept as sound, not as intent.',
    config: {
      sampleRate: 48000, frequency: 220, t60: 3.0, seconds: 4.0,
      amplitude: 0.6, pluckPosition: 0.18, pickupPosition: 0.52,
      excitation: 'pluck', lossLambda: 0.08844444444444444
    }
  },
  {
    id: 'legacy-g3-v2',
    label: 'G3 196 Hz (v2 loop, L²)',
    kernel: 2,
    lossStages: 2,
    note: 'Second legacy preset for the panel’s replace-and-compare action.',
    config: {
      sampleRate: 48000, frequency: 196, t60: 4.0, seconds: 5.0,
      amplitude: 0.6, pluckPosition: 0.22, pickupPosition: 0.47,
      excitation: 'pluck', lossLambda: 0.08417777777777778
    }
  }
];

export function findExample(id) {
  return EXAMPLES.find(e => e.id === id) || null;
}

export function findLegacy(id) {
  return LEGACY_PRESETS.find(p => p.id === id) || null;
}
