/*
 * Plucked-string digital waveguide.
 *
 * ── Loop ────────────────────────────────────────────────────────────────
 *
 *   exc[n] ─► ( + ) ─► delay line (Nint samples) ─► allpass A(z)
 *              ▲                                        │
 *              │                                        ▼
 *              └──────────── g · L(z)^2 ◄──────── one-zero loss ×2
 *
 *   H_loop(z) = g · A(z) · L(z)^2 · z^-Nint
 *   A(z) = (a + z^-1) / (1 + a·z^-1)          first-order allpass
 *   L(z) = (1-λ) + λ·z^-1                     first-order lowpass, ×2
 *
 * Tuning solves, at w0 = 2π f0/fs,
 *
 *   fs/f0 = Nint + phaseDelay(A, w0) + 2·phaseDelay(L, w0)
 *
 * using bisection on the allpass coefficient (its phase delay is monotone in
 * a), so the sub-sample delay and the loss filter's own phase shift are both
 * part of the pitch.  The integer delay is chosen to land the required
 * fractional part inside the allpass's available range (which shrinks toward
 * Nyquist) instead of being rounded away.
 *
 * ── Stability ───────────────────────────────────────────────────────────
 *
 *   0 < g ≤ 0.9995, |L(w)| ≤ 1, |a| ≤ 0.98
 *   ⇒ |H_loop(e^jw)| < 1 for every w.
 *
 * Requests that cannot be tuned are rejected with ModelError (never bent or
 * silently clamped).  A divergence watchdog observes the raw internal state
 * and reports a fault; it is not a substitute for the gain bound.
 *
 * ── Excitation and pickup ───────────────────────────────────────────────
 *
 * Pluck position β shapes the excitation with a feed-forward comb
 *   E(z) = 1 - z^-(β·N)
 * whose magnitude ∝ |sin(πkβ)| at harmonic k — the same modal weighting as
 * the triangular initial displacement of a string pulled at β.  The comb
 * delay is in samples of the actual round trip, so β changes the injected
 * signal, not just a label.
 *
 * Pickup position γ is a two-tap reconstruction of string displacement from
 * the travelling wave in the loop:
 *
 *   y[n] = 0.5 · ( s[n - γN/2] - s[n - (2-γ)N/2] )
 *
 * which is zero at both ends and has magnitude ∝ |sin(πkγ)|.  Both taps are
 * read from the loop's own delay line with interpolation, so γ genuinely
 * changes the output samples and the partial amplitudes.
 *
 * ── Supported acoustic mechanisms / measurable range ────────────────────
 *
 *   - one polarisation of a lossy, dispersive (allpass) string
 *   - exact harmonic tuning for f0 < 0.45·fs
 *   - frequency-dependent decay: high partials decay faster via L(z)
 *   - pluck/pickup position modal nulls
 *   - no coupling between strings, no body resonance, no nonlinearity
 *   - T60 is only meaningful down to a few hundred ms; below that the
 *     excitation transient dominates and the measurement is flagged.
 */

export const MAX_LOOP_GAIN = 0.9995;
export const MIN_FREQUENCY = 20;
export const MAX_FREQUENCY_RATIO = 0.45; // of sample rate
export const WAVE_SPEED = 281.6; // m/s, so 0.64 m of this string tunes to 220 Hz
export const MAX_LOSS_LAMBDA = 0.45;
export const AP_MIN_COEFF = -0.98;
export const AP_MAX_COEFF = 0.98;
export const TWO_PI = Math.PI * 2;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export class ModelError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ModelError';
    this.detail = detail;
  }
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function frequencyForStringLength(lengthMeters, waveSpeed = WAVE_SPEED) {
  if (!Number.isFinite(lengthMeters) || lengthMeters <= 0) {
    throw new ModelError('String length must be a positive number of metres', { lengthMeters });
  }
  return waveSpeed / (2 * lengthMeters);
}

export function stringLengthForFrequency(frequency, waveSpeed = WAVE_SPEED) {
  if (!(Number.isFinite(frequency) && frequency > 0)) {
    throw new ModelError('Frequency must be a positive number of Hz', { frequency });
  }
  return waveSpeed / (2 * frequency);
}

export function frequencyToMidi(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function noteName(frequency) {
  if (!(frequency > 0)) return '--';
  const midi = Math.round(frequencyToMidi(frequency));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function centsBetween(a, b) {
  return 1200 * Math.log2(a / b);
}

export function allpassPhaseDelay(a, w) {
  // arg A(e^{jw}) for A(z) = (a + z^-1)/(1 + a z^-1).
  // Rewriting as (a e^{jw} + 1)/(e^{jw} + a) gives angle in (-π, 0] for
  // 0 < w < π, and phaseDelay = -angle / w.
  const numerator = Math.atan2(a * Math.sin(w), 1 + a * Math.cos(w));
  const denominator = Math.atan2(Math.sin(w), a + Math.cos(w));
  return -(numerator - denominator) / w;
}

export function lossPhaseDelay(lambda, w) {
  const re = (1 - lambda) + lambda * Math.cos(w);
  const im = -lambda * Math.sin(w);
  return -Math.atan2(im, re) / w;
}

export function lossMagnitude(lambda, w) {
  const re = (1 - lambda) + lambda * Math.cos(w);
  const im = -lambda * Math.sin(w);
  return Math.hypot(re, im);
}

export function defaultLambda(frequency) {
  const t = clamp((frequency - 60) / 900, 0, 1);
  return 0.06 + 0.16 * t;
}

/*
 * Solve the loop for one period at `frequency`.
 * Single source of truth for the worklet, the offline renderer and tests.
 */
export function solveLoop(frequency, sampleRate, options = {}) {
  if (!(Number.isFinite(frequency) && frequency > 0)) {
    throw new ModelError('Frequency must be positive', { frequency });
  }
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new ModelError('Sample rate must be positive', { sampleRate });
  }
  if (frequency >= sampleRate * MAX_FREQUENCY_RATIO) {
    throw new ModelError(
      'Frequency ' + frequency.toFixed(1) + ' Hz is too close to Nyquist (limit ' +
      (sampleRate * MAX_FREQUENCY_RATIO).toFixed(0) + ' Hz at ' + sampleRate + ' Hz)',
      { frequency, limit: sampleRate * MAX_FREQUENCY_RATIO }
    );
  }
  if (frequency < MIN_FREQUENCY) {
    throw new ModelError(
      'Frequency ' + frequency.toFixed(1) + ' Hz is below the model minimum of ' +
      MIN_FREQUENCY + ' Hz', { frequency, minimum: MIN_FREQUENCY }
    );
  }

  let lambda = options.lossLambda;
  if (lambda === undefined || lambda === null) lambda = defaultLambda(frequency);
  if (!(Number.isFinite(lambda) && lambda >= 0 && lambda < 1)) {
    throw new ModelError('Loss coefficient λ must be in [0, 1)', { lambda });
  }
  if (lambda > MAX_LOSS_LAMBDA) {
    throw new ModelError(
      'Loss coefficient λ=' + lambda.toFixed(3) + ' exceeds the model maximum of ' + MAX_LOSS_LAMBDA,
      { lambda, maximum: MAX_LOSS_LAMBDA }
    );
  }

  const targetDelay = sampleRate / frequency;
  const w = TWO_PI * frequency / sampleRate;
  const lossPhase = 2 * lossPhaseDelay(lambda, w);
  const remaining = targetDelay - lossPhase;
  if (!(remaining > 2.2)) {
    throw new ModelError(
      'Pitch ' + frequency.toFixed(1) + ' Hz leaves no room for a tuned fractional delay',
      { frequency, targetDelay, lossPhase, remaining }
    );
  }

  const maxAllpassDelay = allpassPhaseDelay(AP_MIN_COEFF, w);
  const minAllpassDelay = allpassPhaseDelay(AP_MAX_COEFF, w);
  let integerDelay = Math.max(1, Math.floor(remaining - minAllpassDelay));
  let desiredAllpassDelay = remaining - integerDelay;
  if (desiredAllpassDelay > maxAllpassDelay) {
    integerDelay = Math.max(1, integerDelay - 1);
    desiredAllpassDelay = remaining - integerDelay;
  }
  if (desiredAllpassDelay > maxAllpassDelay || desiredAllpassDelay < minAllpassDelay) {
    throw new ModelError(
      'Pitch ' + frequency.toFixed(1) + ' Hz cannot be tuned with a first-order allpass here',
      { frequency, desiredAllpassDelay, range: [minAllpassDelay, maxAllpassDelay] }
    );
  }

  const allpass = solveAllpassCoefficient(desiredAllpassDelay, w);
  const allpassDelay = allpassPhaseDelay(allpass, w);
  const totalDelay = integerDelay + allpassDelay + lossPhase;
  return {
    frequency,
    sampleRate,
    w,
    targetDelay,
    integerDelay,
    lossLambda: lambda,
    allpass,
    desiredAllpassDelay,
    allpassDelay,
    lossPhase,
    totalDelay,
    tuningErrorCents: centsBetween(totalDelay, targetDelay)
  };
}

/*
 * Invert the allpass phase-delay curve by bisection.  For 0 < w < π,
 * D(a,w) is monotonically decreasing in a.
 */
export function solveAllpassCoefficient(desiredDelay, w) {
  if (!(desiredDelay > 0) || !Number.isFinite(desiredDelay)) {
    throw new ModelError('Allpass delay must be positive and finite', { desiredDelay });
  }
  const maxNeg = allpassPhaseDelay(AP_MIN_COEFF, w);
  const maxPos = allpassPhaseDelay(AP_MAX_COEFF, w);
  if (desiredDelay > maxNeg || desiredDelay < maxPos) {
    throw new ModelError(
      'Fractional delay ' + desiredDelay.toFixed(4) + ' outside allpass range [' +
      maxPos.toFixed(4) + ', ' + maxNeg.toFixed(4) + ']',
      { desiredDelay, range: [maxPos, maxNeg] }
    );
  }
  let lo = AP_MIN_COEFF;
  let hi = AP_MAX_COEFF;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (allpassPhaseDelay(mid, w) > desiredDelay) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/*
 * Loop gain for a target T60 at the fundamental.  Each round trip multiplies
 * the mode by g·|L(w)|²; after f·T60 round trips the amplitude is 1e-3.
 */
export function loopGainForT60(frequency, t60, lambda, options = {}) {
  const { sampleRate, limit = MAX_LOOP_GAIN } = options;
  if (!(Number.isFinite(t60) && t60 > 0)) {
    throw new ModelError('T60 must be a positive number of seconds', { t60 });
  }
  if (!(Number.isFinite(frequency) && frequency > 0)) {
    throw new ModelError('Frequency must be positive', { frequency });
  }
  const w = TWO_PI * frequency / sampleRate;
  const lossMagSq = Math.pow(lossMagnitude(lambda, w), 2);
  if (!(lossMagSq > 0)) {
    throw new ModelError('Loss filter is fully closed; no energy can circulate', { lambda, frequency });
  }
  const required = Math.pow(10, -3 / (t60 * frequency)) / lossMagSq;
  const gain = Math.min(required, limit);
  if (!(gain > 0)) throw new ModelError('Loop gain computed as non-positive', { required, gain });
  return { gain, required, limited: required > limit, limit };
}

/*
 * Decay time of the loop's response at `frequency`, given the tuned loop.
 *
 * Every partial gains the same factor g·|L(w)|² per round trip, and a round
 * trip takes 1/f0 seconds for all partials (a harmonic returns in phase
 * after one period of the fundamental).  The decay rate therefore uses the
 * round-trip rate f0 — `solved.frequency` — not the partial's own frequency.
 * Using the partial frequency here is a common error that makes high-partial
 * T60 predictions far too short.
 */
export function predictedT60ForFrequency(frequency, solved, gain) {
  const w = TWO_PI * frequency / solved.sampleRate;
  const loopMag = gain * Math.pow(lossMagnitude(solved.lossLambda, w), 2);
  if (!(loopMag > 0)) return 0;
  if (loopMag >= 1) return Infinity;
  const tripsPerSecond = solved.frequency || frequency;
  return -3 / (Math.log10(loopMag) * tripsPerSecond);
}

/*
 * Analytic modal weight used for tests/UI comparison:
 * |sin(kπβ)·sin(kπγ)| / (k² β(1-β)), normalised so k=1, β=γ=0.5 → 1.
 */
export function modalWeight(k, pluckPosition, pickupPosition) {
  const b = clamp(pluckPosition, 0.001, 0.999);
  const p = clamp(pickupPosition, 0.001, 0.999);
  return Math.abs(Math.sin(k * Math.PI * b) * Math.sin(k * Math.PI * p)) /
    (k * k * b * (1 - b));
}

/* ───────────────────────────── delay line ───────────────────────────── */

class DelayLine {
  constructor(maxSamples) {
    let size = 8;
    while (size < maxSamples + 4) size <<= 1;
    this.buffer = new Float32Array(size);
    this.size = size;
    this.mask = size - 1;
    this.write = 0;
    this.length = 1; // active loop length in samples, set by configure
  }

  reset() {
    this.buffer.fill(0);
    this.write = 0;
  }

  push(value) {
    this.buffer[this.write] = value;
    this.write = (this.write + 1) & this.mask;
  }

  // Linear-interpolated read `delay` samples before the write head.
  read(delay) {
    const pos = this.write - delay;
    const base = Math.floor(pos);
    const frac = pos - base;
    const i0 = base & this.mask;
    const i1 = (base + 1) & this.mask;
    const a = this.buffer[i0];
    return a + frac * (this.buffer[i1] - a);
  }

  /*
   * Spatial displacement profile, using the same two-tap reconstruction as
   * the pickup: u(γ) = ½(s[n−γN/2] − s[n−(2−γ)N/2]).  This is what the
   * string is actually doing at this instant, so a display driven by it
   * shows the plucked shape peaking at the pluck position and pinned at both
   * ends — not a decorative animation.
   */
  displacementProfile(count, into = new Float32Array(count), offset = 0) {
    const half = this.length * 0.5;
    for (let i = 0; i < count; i++) {
      const gamma = i / (count - 1);
      const near = this.read(Math.max(0.001, gamma * half + offset));
      const far = this.read(Math.max(0.001, (2 - gamma) * half + offset));
      into[i] = 0.5 * (near - far);
    }
    return into;
  }

  /*
   * Vibration envelope along the string: RMS of the displacement profile over
   * one fundamental period.  This is the standing-wave shape (nodes and
   * antinodes) rather than an instantaneous snapshot, and its level decays
   * with T60 — both read directly from the delay line.
   */
  displacementEnvelope(count, samplesPerPeriod = this.length) {
    const out = new Float32Array(count);
    const scratch = new Float32Array(count);
    const steps = Math.max(4, Math.min(12, Math.floor(samplesPerPeriod)));
    const stride = Math.max(1, Math.floor(samplesPerPeriod / steps));
    for (let s = 0; s < steps; s++) {
      this.displacementProfile(count, scratch, s * stride);
      for (let i = 0; i < count; i++) out[i] += scratch[i] * scratch[i];
    }
    const norm = 1 / steps;
    for (let i = 0; i < count; i++) out[i] = Math.sqrt(out[i] * norm);
    return out;
  }
}

/* ────────────────────────────── the string ──────────────────────────── */

export class StringModel {
  constructor(sampleRate = 48000) {
    if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
      throw new ModelError('Sample rate must be positive', { sampleRate });
    }
    this.sampleRate = sampleRate;
    this.line = new DelayLine(Math.ceil(sampleRate / MIN_FREQUENCY) + 8);
    this.solved = null;
    this.gain = 0;
    this.pluckPosition = 0.18;
    this.pickupPosition = 0.52;
    this.excitation = null;
    this.exciteIndex = 0;
    this.state = 'idle';
    this.fault = null;
    this.resetCounters();
    this.allpassX1 = 0;
    this.allpassY1 = 0;
    this.lossIn1 = 0;
    this.lossIn2 = 0;
    this.observe = {
      delayed: 0, allpassOut: 0, loss1: 0, loss2: 0, looped: 0,
      excitation: 0, write: 0, tapNear: 0, tapFar: 0, out: 0
    };
  }

  resetCounters() {
    this.peak = 0;
    this.rms = 0;
    this.loopPeak = 0;
    this.trips = 0;
    this.samplesSinceTrip = 0;
    this.watchdog = 0;
    this.diverged = false;
    this.loopRms = 0;
    this.silentSamples = 0;
  }

  configure({ frequency, t60, lossLambda, pluckPosition, pickupPosition }) {
    const solved = solveLoop(frequency, this.sampleRate, { lossLambda });
    const gainInfo = loopGainForT60(frequency, t60, solved.lossLambda, {
      sampleRate: this.sampleRate
    });
    if (pluckPosition !== undefined) this.pluckPosition = clamp(pluckPosition, 0.02, 0.98);
    if (pickupPosition !== undefined) this.pickupPosition = clamp(pickupPosition, 0.02, 0.98);
    this.solved = solved;
    this.gain = gainInfo.gain;
    this.gainLimited = gainInfo.limited;
    this.t60 = t60;
    this.line.length = Math.max(2, solved.integerDelay);
    return {
      ...solved,
      gain: this.gain,
      gainLimited: this.gainLimited,
      t60,
      pluckPosition: this.pluckPosition,
      pickupPosition: this.pickupPosition
    };
  }

  reset() {
    this.line.reset();
    this.allpassX1 = 0;
    this.allpassY1 = 0;
    this.lossIn1 = 0;
    this.lossIn2 = 0;
    this.excitation = null;
    this.exciteIndex = 0;
    this.state = 'idle';
    this.resetCounters();
    this.fault = null;
  }

  /*
   * Pluck: load the released triangular displacement into the loop.
   *
   * A string pulled aside at β and released has y(x,0) triangular, which
   * splits into two travelling waves.  In the single-delay-loop waveguide
   * that initial state is the loop's contents for one round trip, so the
   * excitation is short (N samples, a few ms to ~20 ms) but already contains
   * every partial with weight sin(kπβ)/k².  The loop then propagates and
   * decays it; nothing else is injected afterwards.
   *
   * The spatial mean is removed.  For k ≥ 1 a constant is orthogonal to
   * sin(kπx), so harmonic weights are unchanged; it only removes the mode-0
   * component that a fixed-fixed string cannot support (and that a one-zero
   * loss filter would leave undamped).
   */
  pluck(amplitude = 0.6, pluckPosition = this.pluckPosition) {
    if (!this.solved) throw new ModelError('String is not configured');
    if (!(Number.isFinite(amplitude) && amplitude > 0 && amplitude <= 4)) {
      throw new ModelError('Pluck amplitude must be in (0, 4]', { amplitude });
    }
    const beta = clamp(pluckPosition, 0.02, 0.98);
    const N = Math.max(8, this.solved.integerDelay);
    const peakIndex = Math.min(N - 2, Math.max(1, Math.round(beta * N)));
    const shape = new Float32Array(N);
    let peak = 0;
    for (let i = 0; i < N; i++) {
      const tri = i <= peakIndex
        ? i / peakIndex
        : (N - 1 - i) / (N - 1 - peakIndex);
      shape[i] = Math.max(0, tri);
      peak = Math.max(peak, shape[i]);
    }
    let mean = 0;
    for (let i = 0; i < N; i++) mean += shape[i];
    mean /= N;
    const scale = amplitude / Math.max(1e-9, peak);
    for (let i = 0; i < N; i++) shape[i] = (shape[i] - mean) * scale;

    this.reset();
    this.pluckPosition = beta;
    this.excitation = shape;
    this.exciteIndex = 0;
    this.state = 'excited';
    this.peak = amplitude;
    return {
      shapeLength: N,
      peakIndex,
      shapeMs: 1000 * N / this.sampleRate,
      amplitude,
      pluckPosition: beta
    };
  }

  /*
   * Short noise burst weighted by the pluck-position triangle.  Injecting it
   * into the loop over a few milliseconds gives a brighter, more percussive
   * attack while keeping the pluck-position modal weighting.  Seeded so the
   * offline reference is reproducible.
   */
  burst(amplitude = 0.45, durationMs = 2.5, pluckPosition = this.pluckPosition) {
    if (!this.solved) throw new ModelError('String is not configured');
    if (!(Number.isFinite(amplitude) && amplitude > 0 && amplitude <= 4)) {
      throw new ModelError('Burst amplitude must be in (0, 4]', { amplitude });
    }
    const beta = clamp(pluckPosition, 0.02, 0.98);
    const N = Math.max(8, this.solved.integerDelay);
    const peakIndex = Math.min(N - 2, Math.max(1, Math.round(beta * N)));
    const burstLength = Math.max(8, Math.round(this.sampleRate * durationMs / 1000));
    const exc = new Float32Array(burstLength);
    let seed = 0x1a2b3c4d;
    for (let i = 0; i < burstLength; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const window = 0.5 - 0.5 * Math.cos(TWO_PI * (i + 1) / (burstLength + 1));
      const tri = i < N
        ? (i <= peakIndex ? i / peakIndex : (N - 1 - i) / (N - 1 - peakIndex))
        : 0;
      exc[i] = noise * window * Math.max(0, tri);
    }
    let mean = 0;
    for (let i = 0; i < burstLength; i++) mean += exc[i];
    mean /= burstLength;
    let peak = 0;
    for (let i = 0; i < burstLength; i++) {
      exc[i] -= mean;
      peak = Math.max(peak, Math.abs(exc[i]));
    }
    if (peak > 0) {
      const scale = amplitude / peak;
      for (let i = 0; i < burstLength; i++) exc[i] *= scale;
    }
    this.reset();
    this.pluckPosition = beta;
    this.excitation = exc;
    this.exciteIndex = 0;
    this.state = 'excited';
    this.peak = amplitude;
    return { excitationLength: burstLength, amplitude, pluckPosition: beta };
  }

  /*
   * One sample.  All state updates are explicit so the worklet and offline
   * renderer share exactly the same arithmetic.
   */
  tick() {
    const s = this.solved;
    if (!s) return 0;

    // 1. Read the loop one integer delay back.
    const delayed = this.line.read(s.integerDelay);

    // 2. Fractional delay: first-order allpass.
    const allpassOut = s.allpass * delayed + this.allpassX1 - s.allpass * this.allpassY1;
    this.allpassX1 = delayed;
    this.allpassY1 = allpassOut;

    // 3. Frequency-dependent loss: two cascaded one-zero lowpass stages.
    //    L(z) = (1-λ) + λ z^-1, exactly as used by the tuning solver.
    const loss1 = (1 - s.lossLambda) * allpassOut + s.lossLambda * this.lossIn1;
    this.lossIn1 = allpassOut;
    const loss2 = (1 - s.lossLambda) * loss1 + s.lossLambda * this.lossIn2;
    this.lossIn2 = loss1;

    // 4. Loop gain and summation with excitation.
    const looped = this.gain * loss2;
    let excitation = 0;
    if (this.excitation && this.exciteIndex < this.excitation.length) {
      excitation = this.excitation[this.exciteIndex++];
      if (this.exciteIndex >= this.excitation.length) {
        this.excitation = null;
        if (this.state === 'excited') this.state = 'ringing';
      }
    }
    const write = excitation + looped;
    this.line.push(write);

    // 5. Pickup: two-tap reconstruction of string displacement at position γ.
    //    y[n] = 0.5·(s[n-γN/2] − s[n-(2-γ)N/2]) is zero at both ends; its
    //    magnitude at harmonic k is ∝ |sin(πkγ)|, so γ moves real nulls.
    const half = s.integerDelay * 0.5;
    const gamma = clamp(this.pickupPosition, 0.02, 0.98);
    const tapNear = this.line.read(gamma * half);
    const tapFar = this.line.read((2 - gamma) * half);
    const out = 0.5 * (tapNear - tapFar);

    // Telemetry / watchdog.
    const absWrite = Math.abs(write);
    if (!Number.isFinite(write) || absWrite > 1e6) {
      this.watchdog++;
      if (this.watchdog > 8 && !this.diverged) {
        this.diverged = true;
        this.fault = {
          type: 'divergence',
          message: 'Internal loop state exceeded 1e6; model halted',
          sample: this.trips * s.integerDelay + this.samplesSinceTrip
        };
        this.state = 'fault';
        this.excitation = null;
        this.line.reset();
      }
    } else {
      this.watchdog = 0;
    }
    if (absWrite > this.loopPeak) this.loopPeak = absWrite;
    this.loopRms += 0.004 * (write * write - this.loopRms);
    const absOut = Math.abs(out);
    if (absOut > this.peak) this.peak = absOut;
    this.rms += 0.0005 * (out * out - this.rms);
    if (++this.samplesSinceTrip >= s.integerDelay) {
      this.samplesSinceTrip = 0;
      this.trips++;
    }
    // The loop content is the source of truth for "still sounding": when the
    // running loop energy has been inaudible for a few hundred milliseconds,
    // report idle.  Output level alone would be misleading near a pickup null.
    if (!this.diverged && this.state !== 'idle' && !this.excitation) {
      if (this.loopRms < 1e-10) this.silentSamples++;
      else this.silentSamples = 0;
      if (this.silentSamples > this.sampleRate * 0.25) {
        this.state = 'idle';
        this.silentSamples = 0;
      }
    }
    this.observe.delayed = delayed;
    this.observe.allpassOut = allpassOut;
    this.observe.loss1 = loss1;
    this.observe.loss2 = loss2;
    this.observe.looped = looped;
    this.observe.excitation = excitation;
    this.observe.write = write;
    this.observe.tapNear = tapNear;
    this.observe.tapFar = tapFar;
    this.observe.out = out;
    return out;
  }

  snapshot() {
    const s = this.solved;
    return {
      state: this.state,
      diverged: this.diverged,
      fault: this.fault,
      frequency: s ? s.frequency : 0,
      integerDelay: s ? s.integerDelay : 0,
      allpass: s ? s.allpass : 0,
      allpassDelay: s ? s.allpassDelay : 0,
      lossLambda: s ? s.lossLambda : 0,
      lossPhase: s ? s.lossPhase : 0,
      targetDelay: s ? s.targetDelay : 0,
      totalDelay: s ? s.totalDelay : 0,
      tuningErrorCents: s ? s.tuningErrorCents : 0,
      gain: this.gain,
      gainLimited: !!this.gainLimited,
      pluckPosition: this.pluckPosition,
      pickupPosition: this.pickupPosition,
      peak: this.peak,
      rms: Math.sqrt(this.rms * 2),
      trips: this.trips,
      loopPeak: this.loopPeak,
      excitationActive: !!this.excitation,
      t60: this.t60 || 0,
      predictedT60: s ? predictedT60ForFrequency(s.frequency, s, this.gain) : 0
    };
  }
}
