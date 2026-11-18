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
 * Decay time of one harmonic, measured with long Hann-windowed segments so
 * neighbouring partials cannot leak into the estimate.
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
  if (points.length < 3) return { t60: NaN, reliable: false, points };
  const reference = points[0].db;
  const kept = points.filter(p => p.db > reference + floorDb);
  if (kept.length < 3) return { t60: NaN, reliable: false, points };
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of kept) { n++; sx += p.t; sy += p.db; sxx += p.t * p.t; sxy += p.t * p.db; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const t60 = slope < 0 ? -60 / slope : Infinity;
  const covered = kept[kept.length - 1].t - kept[0].t;
  return { t60, reliable: covered > 0.1 && Number.isFinite(t60), points: kept, covered };
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
  if (points.length < 2) return { t60: NaN, points, slopeDbPerSecond: NaN, reliable: false };
  const reference = points[0].db;
  const kept = points.filter(p => p.db > reference + floorDb);
  if (kept.length < 2) return { t60: NaN, points, slopeDbPerSecond: NaN, reliable: false };
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of kept) {
    n++; sx += p.t; sy += p.db; sxx += p.t * p.t; sxy += p.t * p.db;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const t60 = slope < 0 ? -60 / slope : Infinity;
  const coveredSeconds = kept[kept.length - 1].t - kept[0].t;
  return {
    t60,
    slopeDbPerSecond: slope,
    points: kept,
    windowSeconds: windowLength / sampleRate,
    coveredSeconds,
    reliable: kept.length >= 3 && coveredSeconds > Math.min(0.2, t60 * 0.3) &&
      t60 > 0.15 && t60 < 30
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
