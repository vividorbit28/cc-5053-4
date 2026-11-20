/*
 * Regenerate the executable example library.
 *
 *   node scripts/generate-examples.js [--check]
 *
 * For every case in examples/library.js it:
 *
 *   1. renders the pluck through the same kernel the worklet uses,
 *   2. measures the base *period* by phase slope, with a 95% CI,
 *   3. measures each requested partial's T60 by windowed regression, recording
 *      the exact span of audio the fit used and a 95% CI on the slope,
 *   4. compares both against the case's declared targets and FAILS the run if
 *      anything falls outside tolerance or a "must be indeterminate" case
 *      accidentally produced a number.
 *
 * It also rewrites examples/reference/conventions.json: which tuning
 * conventions from the previous (two-stage) filter are still true, and which
 * are now false, with the measured evidence for each.  Finally it checks the
 * v2-preset conversion against a retained plucked recording: the old sound is
 * rendered and kept in examples/reference/, and a conversion is accepted only
 * if the converted render matches that recording's measured decay, not merely
 * its source parameters.
 *
 * `--check` performs every measurement but writes nothing and exits non-zero
 * on any failure.  That is what `npm run examples:check` runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXAMPLES, LEGACY_PRESETS, LIBRARY_VERSION
} from '../examples/library.js';
import { renderString, encodeWav } from '../src/core/offline.js';
import {
  measureFundamentalPeriod, measurePartialDecay, measureDecay
} from '../src/core/analysis.js';
import {
  StringModel, solveLoop, defaultLambda, LOSS_STAGES, MAX_LOSS_LAMBDA
} from '../src/core/string-model.js';
import {
  convertLambda, fitLambdaToProfile
} from '../src/core/conversion.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const refDir = path.join(root, 'examples', 'reference');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

const failures = [];
const warnings = [];
function fail(message) { failures.push(message); console.log('FAIL ' + message); }
function warn(message) { warnings.push(message); console.log('WARN ' + message); }

/*────────────── rendering a case, including the loss-phase drift ───────────*/

function renderCase(config) {
  const cfg = { ...config };
  if (cfg.lossLambda === null) delete cfg.lossLambda;
  return renderString(cfg);
}

/*──────────────────────────── measurements ───────────────────────────────*/

function measureCase(rendered, frequency) {
  const { samples, cfg } = rendered;
  const fs = cfg.sampleRate;
  const pitch = measureFundamentalPeriod(samples, frequency, fs);
  const overall = measureDecay(samples, frequency, fs, {
    startSeconds: 0.08,
    expectedT60: cfg.t60
  });
  return { pitch, overall };
}

function measurePartial(rendered, harmonic, frequency) {
  const { samples, cfg } = rendered;
  const f = frequency * harmonic;
  if (f >= cfg.sampleRate * 0.45) return null;
  return measurePartialDecay(samples, f, cfg.sampleRate, {
    startSeconds: 0.05,
    windowSeconds: 0.18
  });
}

/*────────────────────── convention audit (v2 → v3) ───────────────────────*/

/*
 * Render a loop with the *stored* N and allpass of a two-stage solve, but the
 * current single loss stage.  Shows what carrying a v2 preset forward without
 * re-tuning does to the pitch.
 */
function renderStoredLoop(frequency, sampleRate, lambda) {
  const stored = solveLoop(frequency, sampleRate, { lossLambda: lambda, lossStages: 2 });
  const model = new StringModel(sampleRate);
  model.configure({ frequency, t60: 3, lossLambda: 0.05 });
  model.solved = {
    ...stored,
    lossLambda: lambda,
    lossStages: 1,
    lossPhase: lossPhaseDelayTotalForOne(lambda, stored.w)
  };
  model.line.length = stored.integerDelay;
  model.pluck(0.6, 0.18);
  const samples = new Float32Array(Math.round(3.5 * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = model.tick();
  const measured = measureFundamentalPeriod(samples, frequency, sampleRate);
  return {
    periodMeasured: measured.period,
    f0Measured: measured.f0,
    cents: measured.cents,
    status: measured.status
  };
}

function lossPhaseDelayTotalForOne(lambda, w) {
  const re = (1 - lambda) + lambda * Math.cos(w);
  const im = -lambda * Math.sin(w);
  return -Math.atan2(im, re) / w;
}

/*
 * The v2 README and JSON asserted several things about the loop that were
 * true of L(z)².  Each claim is re-tested against the current filter — and
 * where a claim is about *sound*, against rendered audio, not just algebra.
 */
function auditConventions(rendered) {
  const fs = 48000;
  const f = 220;
  const solved = solveLoop(f, fs);
  const legacy = solveLoop(f, fs, { lossLambda: 0.08844444444444444, lossStages: 2 });
  // "Loss phase is applied twice."
  const lossPhaseSingle = solved.lossPhase;
  const lossPhaseDouble = legacy.lossPhase;

  // Decay-ratio claims, checked on audio.
  function measuredRatio(branch, k = 5) {
    const r = rendered[branch];
    const a = measurePartialDecay(r.samples, f * k, fs, { startSeconds: 0.05, windowSeconds: 0.18 });
    const b = measurePartialDecay(r.samples, f, fs, { startSeconds: 0.05, windowSeconds: 0.18 });
    return a.status === 'measured' && b.status === 'measured' ? a.t60 / b.t60 : NaN;
  }
  // The same stored λ (0.08844) rendered as v2 and as v3.
  const ratioLegacy = measuredRatio('legacy2');
  const ratioCarried = measuredRatio('carried1');
  const sameLambdaSameRatio = Math.abs(ratioCarried / ratioLegacy - 1) < 0.02;

  // "An auto-λ preset keeps its timbre when carried forward."  Compare the
  // auto curve's current sound to the v2 auto sound at the same pitch.
  const ratioAutoNow = measuredRatio('newauto');
  const autoCurveSurvived = Math.abs(ratioAutoNow / ratioLegacy - 1) < 0.02;

  // "Carrying the stored solved N forward is still the right integer delay."
  const sameIntegerDelay = solved.integerDelay === legacy.integerDelay;

  // "λ can always be raised to compensate for one fewer stage."  Test a high
  // pitch where the v2 exponent needs more loss than the model permits.
  const highOld = 0.2058;
  const highConverted = convertLambda(880, highOld, 2);
  const conversionSaturates = highConverted.limited;

  // "The stored solved period still tunes to the same pitch."  Render the
  // stored (N, a, λ) as a v3 single-stage loop, holding N and the allpass
  // coefficient fixed, and measure where it actually lands.
  const carriedPitch = renderStoredLoop(220, 48000, 0.08844444444444444);
  const carriedDetuned = Math.abs(carriedPitch.cents ?? Infinity) >= 0.5;

  return [
    {
      claim: 'Loss phase contributes twice to the tuned period',
      legacy: '2·phaseDelay(L, ω0)',
      current: 'phaseDelay(L, ω0)',
      holds: false,
      evidence: 'at 220 Hz the v2 loss phase is ' + lossPhaseDouble.toFixed(4) +
        ' samples; the current filter contributes ' + lossPhaseSingle.toFixed(4)
    },
    {
      claim: 'A given λ sets the same partial-5 / fundamental decay ratio',
      legacy: 'L² with λ_old',
      current: 'L with the same λ',
      holds: sameLambdaSameRatio,
      evidence: 'stored λ=0.08844: recorded ratio ' + ratioLegacy.toFixed(4) +
        ', carried ratio ' + ratioCarried.toFixed(4)
    },
    {
      claim: 'The auto damping curve keeps its timbre when carried forward',
      legacy: '0.06 + 0.16·t',
      current: 'single-stage re-fit (' + defaultLambda(f).toFixed(3) + ' at 220 Hz)',
      holds: autoCurveSurvived,
      evidence: 'recorded ratio ' + ratioLegacy.toFixed(4) +
        ', current auto ratio ' + ratioAutoNow.toFixed(4)
    },
    {
      claim: 'The solved integer delay N recorded under v2 is still correct',
      legacy: 'N from L²',
      current: 'N from L',
      holds: sameIntegerDelay,
      evidence: 'at 220 Hz v2 N=' + legacy.integerDelay + ', v3 N=' + solved.integerDelay
    },
    {
      claim: 'A v2 preset keeps its pitch when its stored N and allpass are carried forward',
      legacy: 'stored N, a under L²',
      current: 'same N, a under L',
      holds: !carriedDetuned,
      evidence: 'carried loop measures ' + (carriedPitch.cents ?? NaN).toFixed(2) +
        ' cents (' + (carriedPitch.status || 'n/a') + ')'
    },
    {
      claim: 'λ can always be raised enough to match the v2 decay profile',
      legacy: 'λ_old ≤ 0.45',
      current: 'λ_new ≤ ' + MAX_LOSS_LAMBDA,
      holds: !conversionSaturates,
      evidence: 'at 880 Hz the required λ is ' + highConverted.lambda.toFixed(3) +
        (conversionSaturates ? ', capped at ' + MAX_LOSS_LAMBDA : '')
    }
  ];
}

/*────────────────── retained recording vs conversion check ───────────────*/

function renderLegacySound(preset) {
  const cfg = { ...preset.config };
  cfg.lossStages = preset.lossStages;
  return renderString(cfg);
}

function compareConversions(renderedByPreset) {
  const rows = [];
  for (const preset of LEGACY_PRESETS) {
    const legacy = renderedByPreset.get(preset.id);
    const fs = preset.config.sampleRate;
    const f0 = preset.config.frequency;

    // Measurements of the RETAINED recording — this is the reference, not the
    // source parameters.  The conversion target is the recorded decay profile.
    const legacyPitch = measureFundamentalPeriod(legacy.samples, f0, fs);
    const recordedPartials = {};
    for (const k of [1, 2, 4, 5]) recordedPartials[k] = measurePartial(legacy, k, f0);

    // Fit λ on the RECORDED partial-5 T60, not on the stored source numbers.
    const targetProfile = [1, 2, 4, 5]
      .filter(k => recordedPartials[k] && recordedPartials[k].status === 'measured')
      .map(k => ({ k, t60: recordedPartials[k].t60 }));
    const conv = fitLambdaToProfile(f0, fs, preset.config.t60, targetProfile);

    // Naive carry-over: identical stored λ, current single stage.
    const naive = renderString({ ...preset.config, lossStages: 1 });

    // Converted: λ fitted to the recording, then re-rendered and re-measured.
    const converted = renderString({ ...preset.config, lossLambda: conv.lambda, lossStages: 1 });

    const comparison = {};
    for (const k of [1, 2, 4, 5]) {
      const naiveM = measurePartial(naive, k, f0);
      const convM = measurePartial(converted, k, f0);
      comparison[k] = {
        reference: recordedPartials[k] ? recordedPartials[k].t60 : NaN,
        naive: naiveM ? naiveM.t60 : NaN,
        converted: convM ? convM.t60 : NaN,
        referenceStatus: recordedPartials[k] ? recordedPartials[k].status : null
      };
    }

    // Acceptance: the converted render must reproduce the retained recording's
    // measured partial-5 T60 within 3%, and its pitch within 1 cent.  The
    // naive carry-over must fail this — that failure is the point of keeping
    // the recording.
    const convertedPitch = measureFundamentalPeriod(converted.samples, f0, fs);
    const refT60_5 = comparison[5].reference;
    const convT60_5 = comparison[5].converted;
    const naiveT60_5 = comparison[5].naive;
    const pitchDelta = Math.abs(convertedPitch.cents ?? Infinity);
    const decayDelta = Math.abs(convT60_5 - refT60_5) / refT60_5;
    const naiveDelta = Math.abs(naiveT60_5 - refT60_5) / refT60_5;

    if (!(pitchDelta < 1)) {
      fail(preset.id + ': converted pitch is ' + (convertedPitch.cents ?? NaN).toFixed(2) +
        ' cents off the retained recording');
    }
    if (!(decayDelta < conv.acceptanceTolerance)) {
      fail(preset.id + ': converted partial-5 T60 differs from the retained recording by ' +
        (decayDelta * 100).toFixed(1) + '% (limit ' +
        (conv.acceptanceTolerance * 100).toFixed(1) + '%)');
    }
    if (naiveDelta <= 0.05) {
      fail(preset.id + ': carrying the stored λ forward reproduced the recording within 5%; ' +
        'the conversion check is no longer exercising anything');
    }

    // Best achievable conversion across the range where λ does not saturate;
    // at high pitch the single stage cannot match L², and the report says so.
    rows.push({
      preset: preset.id,
      label: preset.label,
      frequency: f0,
      sampleRate: fs,
      legacyKernel: preset.kernel,
      legacyLossStages: preset.lossStages,
      legacyLambda: preset.config.lossLambda,
      convertedLambda: conv.lambda,
      conversionLimited: conv.limited,
      conversionFitError: conv.relativeFitError,
      conversionTolerance: conv.acceptanceTolerance,
      referencePitchCents: legacyPitch.cents,
      referencePitchStatus: legacyPitch.status,
      convertedPitchCents: convertedPitch.cents,
      partialT60: comparison,
      naiveRelativeError: naiveDelta,
      convertedRelativeError: decayDelta,
      accepted: pitchDelta < 1 && decayDelta < conv.acceptanceTolerance
    });
  }
  return rows;
}

/*──────────────────────────── generation run ─────────────────────────────*/


const generated = [];
for (const example of EXAMPLES) {
  const rendered = renderCase(example.config);
  const fs = example.config.sampleRate;
  const f0 = example.config.frequency;
  const m = measureCase(rendered, f0);
  const entry = {
    id: example.id,
    pair: example.pair,
    role: example.role,
    note: example.note,
    config: example.config,
    solved: {
      integerDelay: rendered.solved.integerDelay,
      allpass: rendered.solved.allpass,
      allpassDelay: rendered.solved.allpassDelay,
      lossLambda: rendered.solved.lossLambda,
      lossStages: rendered.solved.lossStages,
      lossPhase: rendered.solved.lossPhase,
      boundaryDistance: rendered.solved.boundaryDistance,
      totalDelay: rendered.solved.totalDelay,
      tuningErrorCents: rendered.solved.tuningErrorCents
    },
    measured: {
      periodSamples: m.pitch.period,
      periodCI: m.pitch.periodCI,
      cents: m.pitch.cents,
      centsCI: m.pitch.centsCI,
      pitchStatus: m.pitch.status,
      pitchReason: m.pitch.reason,
      pitchFitStart: m.pitch.fitStart,
      pitchFitEnd: m.pitch.fitEnd,
      // Phase is stored to 9 decimals: the residual frequency offset is tiny,
      // so 4 decimals would quantise the very slope the plot is meant to show.
      pitchPhasePoints: (m.pitch.points || []).map(p => [
        Number(p.t.toFixed(6)), Number(p.phase.toFixed(9))
      ]),
      pitchPhaseSlope: m.pitch.phaseSlope,
      pitchPhaseSlopeCI: m.pitch.phaseSlopeCI,
      pitchPhaseIntercept: m.pitch.phaseIntercept,
      overallT60: m.overall.t60,
      overallT60CI: m.overall.t60CI,
      overallT60Status: m.overall.status,
      overallReason: m.overall.reason,
      overallT60FitStart: m.overall.fitStart,
      overallT60FitEnd: m.overall.fitEnd,
      overallDecayPoints: (m.overall.points || []).map(p => [
        Number(p.t.toFixed(4)), Number(p.db.toFixed(3))
      ])
    },
    partials: []
  };

  // Targets: period.
  if (example.targets.periodSamples) {
    const t = example.targets.periodSamples;
    const ok = m.pitch.status === 'measured' &&
      Math.abs(m.pitch.period - t.value) <= t.tolerance;
    if (!ok) {
      fail(example.id + ': period ' + (m.pitch.period?.toFixed(4) ?? 'NaN') +
        ' ± ' + (m.pitch.periodCI?.toFixed(4) ?? 'NaN') +
        ' outside ' + t.value.toFixed(4) + ' ± ' + t.tolerance);
    }
  }
  if (example.targets.integerDelay) {
    const t = example.targets.integerDelay;
    if (rendered.solved.integerDelay !== t.value) {
      fail(example.id + ': integer delay ' + rendered.solved.integerDelay + ' ≠ ' + t.value);
    }
  }
  if (example.targets.boundaryDistance) {
    const t = example.targets.boundaryDistance;
    const d = Math.abs(rendered.solved.boundaryDistance - t.value);
    if (d > t.tolerance) {
      fail(example.id + ': boundary distance ' + rendered.solved.boundaryDistance.toFixed(4) +
        ' outside ' + t.value + ' ± ' + t.tolerance);
    }
  }

  // Targets: per-partial T60.
  if (example.targets.partialT60) {
    for (const [kText, t] of Object.entries(example.targets.partialT60)) {
      const k = Number(kText);
      const decay = measurePartial(rendered, k, f0);
      if (!decay) continue;
      const ok = decay.status === 'measured' && Math.abs(decay.t60 - t.value) <= t.tolerance;
      if (!ok) {
        fail(example.id + ': T60(partial ' + k + ') ' +
          (Number.isFinite(decay.t60) ? decay.t60.toFixed(3) : 'NaN') +
          ' ± ' + (Number.isFinite(decay.t60CI) ? decay.t60CI.toFixed(3) : 'NaN') +
          ' outside ' + t.value + ' ± ' + t.tolerance);
      }
      entry.partials.push({
        harmonic: k,
        frequency: f0 * k,
        measuredT60: decay.t60,
        t60CI: decay.t60CI,
        status: decay.status,
        reason: decay.reason,
        fitStart: decay.fitStart,
        fitEnd: decay.fitEnd,
        windowSeconds: decay.points.length ? 0.18 : null,
        points: decay.points.map(p => [Number(p.t.toFixed(4)), Number(p.db.toFixed(3))])
      });
    }
  }

  // A case that must stay indeterminate.
  if (example.targets.expectIndeterminate) {
    const pitchOpen = m.pitch.status !== 'measured';
    const decayOpen = m.overall.status !== 'measured';
    if (!pitchOpen && !decayOpen) {
      fail(example.id + ': expected an indeterminate measurement but both pitch and T60 were measured');
    }
    const span = m.overall.fitEnd != null && m.overall.fitStart != null
      ? m.overall.fitEnd - m.overall.fitStart : 0;
    if (span >= (example.targets.minFitSpanSeconds || 0)) {
      fail(example.id + ': fit span ' + span.toFixed(3) + ' s should be below ' +
        example.targets.minFitSpanSeconds + ' s');
    }
    entry.indeterminate = {
      pitch: { status: m.pitch.status, reason: m.pitch.reason },
      decay: { status: m.overall.status, reason: m.overall.reason }
    };
  }

  // The loss-phase drift case: render the same loop with λ overridden and
  // confirm the *measured* period moves by the predicted amount.
  if (example.config.lossLambdaOverride !== undefined) {
    const held = renderLossPhaseDrift(example.config);
    if (!held) {
      fail(example.id + ': loss-phase drift could not be rendered');
    } else {
      const shiftCents = 1200 * Math.log2(held.f0Measured / f0);
      const target = example.targets.pitchShiftCents;
      if (Math.abs(shiftCents - target.value) > target.tolerance) {
        fail(example.id + ': loss-phase shift ' + shiftCents.toFixed(2) +
          ' cents outside ' + target.value + ' ± ' + target.tolerance);
      }
      entry.lossPhaseDrift = {
        heldIntegerDelay: held.integerDelay,
        heldAllpass: held.allpass,
        lambdaFrom: example.config.lossLambda,
        lambdaTo: example.config.lossLambdaOverride,
        measuredPeriod: held.periodMeasured,
        measuredF0: held.f0Measured,
        shiftCents,
        expectedShiftCents: target.value,
        status: held.status
      };
    }
  }

  generated.push(entry);
  const p = m.pitch;
  console.log(
    example.id.padEnd(30) +
    ' period ' + (Number.isFinite(p.period) ? p.period.toFixed(4) : '—').padStart(9) +
    ' ± ' + (Number.isFinite(p.periodCI) ? p.periodCI.toFixed(4) : '—').padStart(8) +
    '  ' + (p.status === 'measured' ? 'measured ' : 'INDETERMINATE')
  );
}

/*
 * Hold N and the allpass coefficient at the tuned values from λ_from, then
 * swap only λ.  The measured output pitch is read from the rendered audio.
 */
function renderLossPhaseDrift(config) {
  const fs = config.sampleRate;
  const from = solveLoop(config.frequency, fs, { lossLambda: config.lossLambda });
  const model = new StringModel(fs);
  model.configure({
    frequency: config.frequency,
    t60: config.t60,
    lossLambda: config.lossLambda
  });
  // Freeze exactly the loop the tuner solved: same N, same allpass, same
  // gain.  Then change only λ, so the rendered pitch can move only through
  // the loss filter's phase.
  model.solved = {
    ...from,
    lossLambda: config.lossLambdaOverride,
    lossPhase: from.lossPhase
  };
  model.line.length = from.integerDelay;

  model.pluck(config.amplitude, config.pluckPosition);
  const samples = new Float32Array(Math.round(config.seconds * fs));
  for (let i = 0; i < samples.length; i++) samples[i] = model.tick();
  const measured = measureFundamentalPeriod(samples, config.frequency, fs);
  return {
    integerDelay: from.integerDelay,
    allpass: from.allpass,
    periodMeasured: measured.period,
    f0Measured: measured.f0,
    status: measured.status
  };
}

/* replace-and-compare payload for the maintenance panel */
const legacyRendered = new Map();
for (const preset of LEGACY_PRESETS) legacyRendered.set(preset.id, renderLegacySound(preset));
const conversions = compareConversions(legacyRendered);
for (const row of conversions) {
  console.log('conversion ' + row.preset.padEnd(14) +
    ' λ ' + row.legacyLambda.toFixed(4) + ' → ' + row.convertedLambda.toFixed(4) +
    (row.conversionLimited ? ' (capped)' : '') +
    '  partial-5: recorded ' + row.partialT60[5].reference.toFixed(3) +
    ' / carried ' + row.partialT60[5].naive.toFixed(3) +
    ' / converted ' + row.partialT60[5].converted.toFixed(3) + ' s');
  if (!row.accepted) fail(row.preset + ': conversion did not reproduce the retained recording');
}

const conventions = auditConventions({
  legacy2: renderString({
    sampleRate: 48000, frequency: 220, t60: 3, seconds: 4, amplitude: 0.6,
    pluckPosition: 0.18, pickupPosition: 0.52, excitation: 'pluck',
    lossLambda: 0.08844444444444444, lossStages: 2
  }),
  carried1: renderString({
    sampleRate: 48000, frequency: 220, t60: 3, seconds: 4, amplitude: 0.6,
    pluckPosition: 0.18, pickupPosition: 0.52, excitation: 'pluck',
    lossLambda: 0.08844444444444444, lossStages: 1
  }),
  newauto: renderString({
    sampleRate: 48000, frequency: 220, t60: 3, seconds: 4, amplitude: 0.6,
    pluckPosition: 0.18, pickupPosition: 0.52, excitation: 'pluck'
  })
});
for (const c of conventions) {
  console.log((c.holds ? 'HOLDS ' : 'BROKEN') + '  ' + c.claim + '  [' + c.evidence + ']');
}

const result = {
  libraryVersion: LIBRARY_VERSION,
  kernelLossStages: LOSS_STAGES,
  generatedAt: new Date().toISOString(),
  cases: generated,
  legacyPresets: LEGACY_PRESETS.map(p => ({ ...p, retainedRecording: p.id + '.wav' })),
  conversions,
  conventions
};

if (failures.length === 0) {
  if (!checkOnly) {
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'examples.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(refDir, 'conventions.json'),
      JSON.stringify({ libraryVersion: LIBRARY_VERSION, conventions, conversions }, null, 2));
    for (const preset of LEGACY_PRESETS) {
      const rendered = legacyRendered.get(preset.id);
      fs.writeFileSync(path.join(refDir, preset.id + '.wav'),
        encodeWav(rendered.samples, preset.config.sampleRate));
    }
    console.log('\nWrote ' + path.relative(root, path.join(refDir, 'examples.json')) +
      ', conventions.json and ' + LEGACY_PRESETS.length + ' retained recordings');
  } else {
    console.log('\n--check: all example targets and conversions verified (nothing written)');
  }
}

if (failures.length) {
  console.log('\n' + failures.length + ' failure(s)');
  process.exit(1);
}
if (warnings.length) console.log(warnings.length + ' warning(s)');
console.log('OK');
