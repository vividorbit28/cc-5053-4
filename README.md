# Taut String

A playable plucked-string instrument built on an explicit digital waveguide.
A short excitation enters a delay loop and becomes a sustained, decaying tone.
There is no recorded guitar sample anywhere in the project: every sound is
computed from the propagation model below.

## Run it

```bash
node scripts/serve.js            # http://localhost:4173
```

Open the URL, press **Start audio** (browsers require a gesture), then pluck
the string with **Space**, the **Pluck** button, or by dragging the string
canvas down and releasing.

No build step, no dependencies for the instrument itself (Node 18+). The
AudioWorklet is an ES module and must be served over HTTP — opening
`index.html` from `file://` will not load the DSP.

## What the model is

One delay loop per string, evaluated per sample:

```
exc[n] ─► ( + ) ─► delay line (N samples) ─► allpass A(z) ─► loss L(z)² ─► g ─┐
           ▲                                                                  │
           └──────────────────────────────────────────────────────────────────┘
```

- **Delay line** — integer part of the period, read with linear interpolation.
- **Allpass** `A(z) = (a + z⁻¹)/(1 + a z⁻¹)` — the *fractional* part of the
  period. Its coefficient is solved by bisection so that the loop's phase
  delay equals `fs/f0` exactly.
- **Loss** `L(z) = (1−λ) + λ z⁻¹`, applied twice — a one-zero lowpass whose
  magnitude and phase are both frequency dependent. Its phase shift is part of
  the tuning equation, and its magnitude is what makes high partials decay
  faster than the fundamental.
- **Gain** `g < 1` — set from the requested T60 at the fundamental.

The tuning equation, evaluated at `ω₀ = 2π f₀/fs`, is

```
fs/f0 = N + phaseDelay(A, ω₀) + 2·phaseDelay(L, ω₀)
```

so a non-integer period is handled by the allpass, not by rounding the buffer
length. At 440 Hz on a 48 kHz rate a rounded buffer would be ~1.4 cents sharp;
at 2093 Hz it is several cents sharp. Measured here, tuning error is **below
0.01 cent at every tested pitch** (see `test/model-tests.js`).

### Excitation and pickup positions

The pluck loads the string's released triangular displacement into the loop
for one round trip: a short excitation (4–20 ms depending on pitch) after
which the loop alone sustains the tone. Pluck position β changes that
triangle's peak, giving partial weights ∝ |sin(kπβ)|/k².

The pickup is a two-tap reconstruction of displacement at position γ:

```
y[n] = ½ · ( s[n − γN/2] − s[n − (2−γ)N/2] )
```

which is zero at both ends and has partial magnitude ∝ |sin(kπγ)|. Moving the
pickup to 50% therefore nulls the even harmonics; moving it off centre
restores them. Both effects are measured from rendered audio in the test
suite, not just asserted from the formula.

### Stability

`0 < g ≤ 0.9995` and `|L(ω)| ≤ 1` for every frequency, so the loop magnitude
is below 1 at every mode. The allpass is unconditionally stable for `|a| < 1`.
Requests that cannot be tuned (too close to Nyquist, below 20 Hz, out-of-range
λ, T60 that would require `g ≥ 1`) throw `ModelError` and are reported in the
UI; they are never silently bent or clamped into range.

The output limiter is a final safety net on what leaves the instrument and
clipped samples are counted. It is not what keeps the loop stable — gain
bounding does. A separate watchdog observes the *internal* loop state and
reports a fault (halt + UI error) if it were ever to diverge.

### Supported mechanisms and measurable range

Modelled: one polarisation of a lossy, dispersive string; exact harmonic
tuning; frequency-dependent decay; pluck- and pickup-position modal weighting;
continuous adjustment while sounding.

Not modelled: coupling between strings, body resonances, nonlinear tension,
sympathetic strings, spatial radiation, inharmonicity from string stiffness.

Measurable: f0 (cents), T60 per partial, peak and energy. T60 measurement is
flagged unreliable below ~200 ms, where the excitation transient dominates.

## The panel

- **String** — the standing-wave envelope (RMS displacement over one period)
  computed from the delay-line contents, so it shrinks and changes shape as the
  tone decays. Drag down and release to pluck at that point; drag depth sets
  force.
- **Vibration & output** — live decay envelope in dB against the predicted
  T60 slope, measured f0, loop gain and margin, peak output and clip status.
- **Partial amplitudes** — rendered partial levels (first 40 ms) next to the
  position-model prediction.
- **Performance controls** — string length (0.14–1.80 m, mapped to pitch by
  `f = c/(2L)` with `c = 281.6 m/s`, so 0.64 m is A3), T60, loss λ (auto or
  manual), pluck β, pickup γ, output level. Note presets retune in one click.
- **Waveguide internals** — solved loop parameters (N, allpass coefficient,
  allpass delay, loss phase, total delay, tuning error, gain), live stage
  values (`s[n−N]`, `A(s)`, `L²(A)`, `g·L²`, `+exc`, pickup) and a scope of
  the loop signals. All values come from the running DSP.
- **Offline reference** — renders the current parameters without the realtime
  path, shows measured vs expected f0/T60/peak/energy, and offers the WAV.
  The offline renderer imports the same kernel as the worklet.

Every control change is echoed by the worklet's applied state. If the model
rejects a change, the control snaps back to the last accepted value and the
message appears in the panel.

## Verify

```bash
npm test                         # 119 kernel checks, no browser
npm run render -- --f 220 --t60 3 --out output/reference
npm run test:browser             # headless Chromium, needs Playwright
npm run test:matrix              # six UI configurations end to end
```

`model-tests.js` covers pitch accuracy across 41 Hz–2 kHz at two sample
rates, T60 configuration sweeps, partial decay vs. prediction, modal nulls for
pluck/pickup positions, energy monotonicity, stability under a continuous
parameter sweep, and rejection of invalid requests.

`browser-check.js` drives the actual UI: starts audio, plucks, captures the
worklet output, measures pitch and decay, retunes by changing length, checks
that an invalid pitch surfaces an error, and exercises the offline renderer
and WAV download.

The `scripts/serve.js` and test scripts were run in this environment. In this
sandbox Chromium needs its bundled libraries on the loader path, e.g.
`LD_LIBRARY_PATH=/tmp/chromelibs/root/usr/lib/aarch64-linux-gnu:/tmp/chromelibs/root/lib/aarch64-linux-gnu`
before the browser commands; on a normal desktop Playwright resolves them
itself.
