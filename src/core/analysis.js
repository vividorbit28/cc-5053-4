/*
 * Measurement tools for rendered string audio.
 *
 * These are used by the test suite and by the offline reference renderer.
 * They deliberately analyse only the audio buffer, not model internals, so
 * the tests check the model's audible output rather than its self-report.
 */

export function goertzelMagnitude(buffer, frequency, sampleRate, start = 0, length = buffer.length - start) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(buffer.length, start + length);
  for (let i = start; i < end; i++) {
    const s0 = buffer[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return Math.hypot(re, im) / ((end - start) / 2);
}

// Refine a peak frequency around `nominal` by ternary search on |X(f)|.
export function refineFrequency(buffer, nominal, sampleRate, start = 0, length = buffer.length - start, cents = 60) {
  let lo = nominal * Math.pow(2, -cents / 1200);
  let hi = nominal * Math.pow(2, cents / 1200);
  for (let i = 0; i < 80; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (goertzelMagnitude(buffer, m1, sampleRate, start, length) >
        goertzelMagnitude(buffer, m2, sampleRate, start, length)) {
      hi = m2;
    } else {
      lo = m1;
    }
  }
  return (lo + hi) / 2;
}

export function cents(measured, target) {
  return 1200 * Math.log2(measured / target);
}

/*
 * Goertzel magnitude with an optional Hann window.  The window is essential
 * when measuring a weak high partial in the presence of a strong fundamental;
 * a rectangular window lets the fundamental leak across the whole spectrum.
 */
export function windowedMagnitude(buffer, frequency, sampleRate, start = 0, length = buffer.length - start, hann = true) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(buffer.length, start + length);
  const n = end - start;
  for (let i = 0; i < n; i++) {
    const window = hann ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) : 1;
    const s0 = buffer[start + i] * window + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / (n / 4);
}

/*
 * Two-sided 95% t-quantile.  Kept small on purpose: the fits in this module
 * use at most ~40 points, and a lookup avoids pulling in a statistics library.
 */
const T95 = [
  0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
];
export function tCritical95(df) {
  if (!(df >= 1)) return NaN;
  if (df < T95.length) return T95[df];
  return 1.96 + 2.4 / df; // good approximation past the table
}

/*
 * Least-squares line fit with a 95% CI on the slope.  This is a *raw*
 * regression: it knows nothing about whether the slope means a decay or a
 * phase.  Callers that want a T60 use `fitDecayLine`, which adds the sign
 * check and the seconds-of-tail check.
 *
 * A non-finite slope CI means "not enough usable points"; callers keep the
 * sample but report it as indeterminate rather than inventing a number.
 */
export function fitLineWithCI(points) {
  const n = points.length;
  if (n < 3) {
    return {
      n, slope: NaN, slopeCI: NaN, intercept: NaN, r2: NaN,
      status: 'indeterminate', reason: n + ' points (need >= 3)',
      fitStart: null, fitEnd: null, covered: 0
    };
  }
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    sx += p.t; sy += p.db; sxx += p.t * p.t; sxy += p.t * p.db; syy += p.db * p.db;
  }
  const sxxC = sxx - sx * sx / n;
  const syyC = syy - sy * sy / n;
  const sxyC = sxy - sx * sy / n;
  const slope = sxxC === 0 ? 0 : sxyC / sxxC;
  const intercept = (sy - slope * sx) / n;
  let sse = 0;
  for (const p of points) {
    const e = p.db - (intercept + slope * p.t);
    sse += e * e;
  }
  const df = n - 2;
  const variance = df > 0 ? sse / df : NaN;
  const slopeSE = sxxC > 0 ? Math.sqrt(variance / sxxC) : NaN;
  const slopeCI = slopeSE * tCritical95(df);
  const r2 = syyC > 0 ? 1 - sse / syyC : 1;
  const covered = points[n - 1].t - points[0].t;
  const usable = df >= 2 && Number.isFinite(slopeCI);
  return {
    n, slope, slopeCI, intercept, r2,
    status: usable ? 'measured' : 'indeterminate',
    reason: usable ? null
      : !Number.isFinite(slopeCI) ? 'slope CI not finite'
      : 'too few degrees of freedom',
    fitStart: points[0].t,
    fitEnd: points[n - 1].t,
    covered
  };
}

/* Decay interpretation of a line fit: slope must be negative, the fit must
 * span more than 0.1 s, and the CI must be finite. */
export function fitDecayLine(points) {
  const fit = fitLineWithCI(points);
  const t60 = fit.slope < 0 ? -60 / fit.slope : Infinity;
  const t60CI = fit.slope < 0 && Number.isFinite(fit.slopeCI)
    ? Math.abs(60 * fit.slopeCI / (fit.slope * fit.slope))
    : NaN;
  const measured = fit.status === 'measured' && Number.isFinite(t60) &&
    Number.isFinite(t60CI) && fit.covered > 0.1;
  // A failed fit's own reason (too few points, non-finite CI) is more useful
  // than "no decay": reporting the slope sign for a 2-point line would claim
  // a measurement that never happened.
  const reason = fit.status !== 'measured' ? fit.reason
    : !(fit.slope < 0) ? 'no decay (slope >= 0)'
    : fit.covered <= 0.1 ? 'fit span only ' + fit.covered.toFixed(3) + ' s'
    : !Number.isFinite(t60CI) ? 'slope CI not finite'
    : null;
  return {
    ...fit,
    t60,
    t60CI,
    status: measured ? 'measured' : 'indeterminate',
    reason
  };
}

/*
 * Decay time of one harmonic, measured with long Hann-windowed segments so
 * neighbouring partials cannot leak into the estimate.  The fit reports the
 * exact segment it used and a 95% CI, so a short or noisy tail is visible as
 * "indeterminate" instead of a confident-looking number.
 */
export function measurePartialDecay(buffer, frequency, sampleRate, options = {}) {
  const { startSeconds = 0.05, windowSeconds = 0.18, floorDb = -45 } = options;
  const windowLength = Math.max(2048, Math.round(windowSeconds * sampleRate));
  const start = Math.round(startSeconds * sampleRate);
  const points = [];
  for (let pos = start; pos + windowLength <= buffer.length; pos += Math.round(windowLength / 2)) {
    const mag = windowedMagnitude(buffer, frequency, sampleRate, pos, windowLength);
    if (!(mag > 0)) continue;
    points.push({ t: (pos + windowLength / 2) / sampleRate, db: 20 * Math.log10(mag) });
  }
  if (points.length < 3) {
    return {
      t60: NaN, t60CI: NaN, reliable: false, status: 'indeterminate',
      reason: points.length + ' windows (need >= 3)', points,
      fitStart: null, fitEnd: null, covered: 0
    };
  }
  const reference = points[0].db;
  const kept = points.filter(p => p.db > reference + floorDb);
  const fit = fitDecayLine(kept);
  return {
    t60: fit.t60,
    t60CI: fit.t60CI,
    reliable: fit.status === 'measured',
    status: fit.status,
    reason: fit.reason,
    slopeDbPerSecond: fit.slope,
    r2: fit.r2,
    points: kept,
    fitStart: fit.fitStart,
    fitEnd: fit.fitEnd,
    covered: fit.covered
  };
}

export function rmsOf(buffer, start = 0, length = buffer.length - start) {
  const end = Math.min(buffer.length, start + length);
  let sum = 0;
  for (let i = start; i < end; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function peakOf(buffer, start = 0, length = buffer.length - start) {
  const end = Math.min(buffer.length, start + length);
  let peak = 0;
  for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(buffer[i]));
  return peak;
}

/*
 * Envelope decay time in the band around `frequency`.
 *
 * Splits the buffer into windows of `cyclesPerWindow` periods, measures the
 * Goertzel magnitude in each, fits a line to log-magnitude vs time, and
 * returns the time for a 60 dB drop.  Windows whose magnitude is below
 * `floorDb` relative to the first are discarded, which keeps numerical noise
 * from flattening the fit.
 */
export function measureDecay(buffer, frequency, sampleRate, options = {}) {
  const {
    startSeconds = 0.05,
    cyclesPerWindow = 16,
    floorDb = -50,
    expectedT60 = null
  } = options;
  const period = 1 / frequency;
  let windowLength;
  if (expectedT60 && expectedT60 > 0) {
    // Size windows so a short decay still yields several measurement points.
    const seconds = Math.min(0.3, Math.max(8 * period, expectedT60 / 9));
    windowLength = Math.max(256, Math.round(seconds * sampleRate));
  } else {
    windowLength = Math.max(256, Math.round(cyclesPerWindow * period * sampleRate));
  }
  const start = Math.round(startSeconds * sampleRate);
  const points = [];
  for (let pos = start; pos + windowLength <= buffer.length; pos += windowLength) {
    const mag = goertzelMagnitude(buffer, frequency, sampleRate, pos, windowLength);
    if (!(mag > 0)) continue;
    points.push({ t: (pos + windowLength / 2) / sampleRate, db: 20 * Math.log10(mag) });
  }
  const empty = (reason) => ({
    t60: NaN, t60CI: NaN, slopeDbPerSecond: NaN, points,
    windowSeconds: windowLength / sampleRate,
    coveredSeconds: points.length ? points[points.length - 1].t - points[0].t : 0,
    fitStart: null, fitEnd: null,
    reliable: false, status: 'indeterminate', reason
  });
  if (points.length < 2) return empty(points.length + ' windows (need >= 2)');
  const reference = points[0].db;
  const kept = points.filter(p => p.db > reference + floorDb);
  if (kept.length < 2) return empty('only ' + kept.length + ' windows above the floor');
  const fit = fitDecayLine(kept);
  // Independent sanity bounds: an absurdly long or short T60 is a fit artefact,
  // not a measurement, even when the slope CI happens to be finite.
  const plausible = Number.isFinite(fit.t60) && fit.t60 >= 0.15 && fit.t60 <= 30;
  return {
    t60: fit.t60,
    t60CI: fit.t60CI,
    slopeDbPerSecond: fit.slope,
    r2: fit.r2,
    points: kept,
    windowSeconds: windowLength / sampleRate,
    coveredSeconds: fit.covered,
    fitStart: fit.fitStart,
    fitEnd: fit.fitEnd,
    reliable: fit.status === 'measured' && plausible,
    status: fit.status === 'measured' && plausible ? 'measured' : 'indeterminate',
    reason: fit.status !== 'measured' ? fit.reason
      : !plausible ? 'T60 ' + (Number.isFinite(fit.t60) ? fit.t60.toFixed(2) : '∞') +
        ' s outside the reliable range [0.15, 30] s'
      : null
  };
}

/*
 * Smoothed energy envelope.  A moving average over ~5 blocks removes the
 * ripple from beating partials so the trend, not the ripple, is visible.
 */
export function smoothEnvelope(buffer, sampleRate, blockMs = 20, smoothBlocks = 5) {
  const raw = blockEnergy(buffer, sampleRate, blockMs);
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - smoothBlocks + 1); j <= i; j++) {
      sum += raw[j];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/*
 * Mean-square total energy of a buffer, integrated in 10 ms blocks so the
 * result is insensitive to block size.  Used to check that a louder-string
 * configuration has more energy AND that energy falls with time.
 */
export function blockEnergy(buffer, sampleRate, blockMs = 10) {
  const block = Math.max(1, Math.round(sampleRate * blockMs / 1000));
  const sums = [];
  for (let start = 0; start < buffer.length; start += block) {
    const end = Math.min(buffer.length, start + block);
    let sum = 0;
    for (let i = start; i < end; i++) sum += buffer[i] * buffer[i];
    sums.push(sum / Math.max(1, end - start));
  }
  return sums;
}

export function totalEnergy(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return sum;
}

/*
 * FFT magnitude spectrum (radix-2, in-place).  Requires power-of-two length.
 * Returns magnitudes for bins 0..N/2.
 */
export function spectrum(samples) {
  const n = samples.length;
  if ((n & (n - 1)) !== 0) throw new Error('spectrum length must be a power of two');
  const re = Float64Array.from(samples);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br;
        im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  const mags = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mags[i] = Math.hypot(re[i], im[i]) / n;
  return mags;
}

export function peakFrequencyFromSpectrum(mags, sampleRate, fftSize) {
  let best = 1;
  for (let i = 2; i < mags.length - 1; i++) {
    if (mags[i] > mags[best]) best = i;
  }
  // Parabolic interpolation around the peak for sub-bin accuracy.
  const y0 = mags[best - 1];
  const y1 = mags[best];
  const y2 = mags[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : 0.5 * (y0 - y2) / denom;
  return (best + delta) * sampleRate / fftSize;
}

/*
 * Measure the fundamental *period* from the audio, with a 95% CI in samples
 * and in cents.
 *
 * Estimator: phase slope.  The signal is split into short Hann-windowed
 * blocks; for each block the complex amplitude at the analysis frequency is
 * computed by direct DFT, and the unwrapped phase is regressed against the
 * block's absolute time.  A frequency offset Δf from the analysis frequency
 * appears as a phase slope of 2πΔf, so the slope gives the residual and the
 * regression residual scatter gives a genuine 95% CI on it.  This is a
 * statistical interval on the audio, not a re-statement of the model's own
 * solved delay.
 *
 * Returns the measured period, its CI, the equivalent f0 and cents error,
 * the span of audio used for the phase fit, and a status.  A segment with too
 * few usable blocks (a very short tail) is reported `indeterminate` and kept
 * in the sample list rather than being given a made-up number.
 */
export function measureFundamentalPeriod(buffer, nominalFrequency, sampleRate, options = {}) {
  const {
    startSeconds = 0.08,
    maxSeconds = 1.2
  } = options;
  const start = Math.max(0, Math.round(startSeconds * sampleRate));
  const end = Math.min(buffer.length, start + Math.round(maxSeconds * sampleRate));
  const nominalPeriod = sampleRate / nominalFrequency;

  // Block length: at least ~6 periods so the analysis window isolates the
  // fundamental from its neighbours, but small enough that a residual offset
  // does not wrap past half a cycle between consecutive blocks.
  const blockSeconds = Math.min(0.25, Math.max(6 * nominalPeriod / sampleRate, 0.006));
  const blockLength = Math.max(256, Math.round(blockSeconds * sampleRate));
  if (end - start < blockLength * 4) {
    return emptyPeriodResult('segment shorter than four analysis blocks', start, end, sampleRate);
  }

  const w0 = 2 * Math.PI * nominalFrequency / sampleRate;
  const cos0 = Math.cos(w0);
  const sin0 = Math.sin(w0);
  const points = [];
  for (let from = start; from + blockLength <= end; from += blockLength) {
    // Direct DFT at w0, phase referenced to the block's absolute start so the
    // slope is the true frequency offset rather than an artefact of the hop.
    let re = 0;
    let im = 0;
    let energy = 0;
    for (let i = 0; i < blockLength; i++) {
      const n = from + i;
      // Rotate by w0·i into block-local phase, then add the block's absolute
      // rotation once.  This keeps the trig argument small and exact enough.
      const wr = Math.cos(w0 * i);
      const wi = -Math.sin(w0 * i);
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (blockLength + 1));
      const x = buffer[n] * window;
      re += x * wr;
      im += x * wi;
      energy += x * x;
    }
    const phaseAbs = Math.atan2(im, re) - w0 * from;
    points.push({
      t: (from + blockLength / 2) / sampleRate,
      phase: phaseAbs,
      mag: Math.hypot(re, im),
      energy
    });
  }
  if (points.length < 6) {
    return emptyPeriodResult(points.length + ' analysis blocks (need >= 6)', start, end, sampleRate);
  }

  // Keep blocks whose fundamental is above the segment's noise floor; the
  // phase of a decayed-to-nothing block is meaningless.  The threshold is
  // relative to the loudest block so it adapts to the pluck amplitude.
  const maxMag = Math.max(...points.map(p => p.mag));
  const kept = points.filter(p => p.mag > maxMag * 1e-3);
  if (kept.length < 6) {
    return emptyPeriodResult('only ' + kept.length + ' blocks above the noise floor', start, end, sampleRate);
  }

  // Unwrap the phase along the kept sequence, then regress against time.
  const unwrapped = [];
  let carry = 0;
  let previous = null;
  for (const p of kept) {
    let phase = p.phase + carry;
    if (previous !== null) {
      let delta = phase - previous;
      delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
      phase = previous + delta;
    }
    unwrapped.push({ t: p.t, phase });
    previous = phase;
  }
  const fit = fitLineWithCI(unwrapped.map(u => ({ t: u.t, db: u.phase })));
  if (fit.status !== 'measured' || !Number.isFinite(fit.slope)) {
    return emptyPeriodResult(fit.reason || 'phase slope not measurable', start, end, sampleRate);
  }
  const deltaF = fit.slope / (2 * Math.PI);
  const f0 = nominalFrequency + deltaF;
  const slopeCI = fit.slopeCI / (2 * Math.PI); // Hz
  if (!(f0 > 0) || !Number.isFinite(slopeCI)) {
    return emptyPeriodResult('phase slope CI not finite', start, end, sampleRate);
  }
  const period = sampleRate / f0;
  const periodCI = sampleRate * slopeCI / (f0 * f0);
  const centsCI = 1200 * Math.log2((period + periodCI) / period);
  const base = {
    period, periodCI, f0, f0CI: slopeCI,
    cents: 1200 * Math.log2(f0 / nominalFrequency),
    centsCI,
    blockCount: kept.length,
    blockSeconds,
    fitStart: fit.fitStart,
    fitEnd: fit.fitEnd,
    samplesUsed: end - start,
    // The unwrapped phase samples and the line actually fitted to them.  The
    // UI draws these beside the reported period so the number can be checked
    // against the tail it came from.
    points: unwrapped,
    phaseSlope: fit.slope,
    phaseSlopeCI: fit.slopeCI,
    phaseIntercept: fit.intercept
  };
  // A slope CI that overlaps zero means the phase fit cannot separate the
  // true frequency from the analysis frequency; keep the sample but say so.
  if (slopeCI >= Math.abs(deltaF)) {
    return {
      ...base,
      status: 'indeterminate',
      reason: 'phase slope CI includes 0 (' + deltaF.toFixed(4) + ' ± ' + slopeCI.toFixed(4) + ' Hz)'
    };
  }
  return {
    ...base,
    status: 'measured',
    reason: null
  };
}

function emptyPeriodResult(reason, start, end, sampleRate) {
  return {
    status: 'indeterminate',
    reason,
    period: NaN,
    periodCI: NaN,
    f0: NaN,
    f0CI: NaN,
    cents: NaN,
    centsCI: NaN,
    blockCount: 0,
    fitStart: start / sampleRate,
    fitEnd: end / sampleRate,
    samplesUsed: Math.max(0, end - start)
  };
}
