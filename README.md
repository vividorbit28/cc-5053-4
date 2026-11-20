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
exc[n] ─► ( + ) ─► delay line (N samples) ─► allpass A(z) ─► loss L(z) ─► g ─┐
           ▲                                                                  │
           └──────────────────────────────────────────────────────────────────┘
```

- **Delay line** — integer part of the period, read with linear interpolation.
- **Allpass** `A(z) = (a + z⁻¹)/(1 + a z⁻¹)` — the *fractional* part of the
  period. Its coefficient is solved by bisection so that the loop's phase
  delay equals `fs/f0` exactly.
- **Loss** `L(z) = (1−λ) + λ z⁻¹`, one zero — a lowpass whose magnitude and
  phase are both frequency dependent. Its phase shift is part of the tuning
  equation, and its magnitude is what makes high partials decay faster than
  the fundamental.
- **Gain** `g < 1` — set from the requested T60 at the fundamental.

The tuning equation, evaluated at `ω₀ = 2π f₀/fs`, is

```
fs/f0 = N + phaseDelay(A, ω₀) + phaseDelay(L, ω₀)
```

Both fractional terms move the real pitch. `phaseDelay(L, ω₀)` is not a
correction to ignore: in the `loss-phase-drift` library case the integer delay
and the allpass coefficient are held fixed and only λ changes, and the measured
period moves by 0.35 samples (−2.78 cents). Shortening the delay also changes
how many times per second the loss filter is traversed, so the same λ is a
different amount of decay per second at a different pitch.

A non-integer period is therefore handled by the allpass and the loss phase,
not by rounding the buffer length. At 440 Hz on a 48 kHz rate a rounded buffer would be ~1.4 cents sharp;
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

Measurable: f0 (cents), T60 per partial, peak and energy. The period is
measured by phase slope (unwrapped Hann-windowed DFT blocks regressed against
time) and carries a genuine 95% CI; partial T60s come from windowed decay
regressions and also carry a slope CI. A measurement whose interval cannot be
formed — too few blocks, a slope CI that includes zero, a tail shorter than the
fit — is reported `indeterminate` with the reason and kept in the sample set
rather than replaced by a number. T60 is additionally implausible outside
0.15–30 s.

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
  values (`s[n−N]`, `A(s)`, `L(A)`, `g·L`, `+exc`, pickup) and a scope of the
  loop signals. All values come from the running DSP.
- **Example library** — every case from `examples/library.js` as measured from
  rendered audio: base period with its 95% CI, per-partial T60, measured f0 in
  cents, and the exact time span both fits used. Cases whose tail is too short
  stay in the table marked *indeterminate* with the reason. "Curves beside the
  measurement" draws the period implied by the local phase slope against the
  reported period and CI, and the decay windows against the fitted line and
  fit span; an unfitted case shows its raw windows and no trend.
- **Preset maintenance** — replaces a v2 preset. It loads the retained WAV,
  measures the partial decay from that audio, fits a single-stage λ to the
  measurements, and shows the recorded sound beside the carried-over and
  converted renders. λ fitted to the recording reproduces partial-5 within
  ~0.2%; carrying the stored λ misses by ~7% and is flagged as wrong.
  "Apply converted to panel" sets the live λ and turns auto damping off so the
  converted value actually reaches the loop.
- **Offline reference** — renders the current parameters without the realtime
  path, shows measured vs expected f0/T60/peak/energy, and offers the WAV.
  The offline renderer imports the same kernel as the worklet.

Every control change is echoed by the worklet's applied state. If the model
rejects a change, the control snaps back to the last accepted value and the
message appears in the panel.

## The example library

`examples/library.js` is the executable part of the documentation:
`npm run examples:generate` renders every case through the kernel, measures it
from the audio, and fails if a measured value leaves its declared tolerance
(`npm run examples:check` does the same without writing).

Two pairs do the work:

| Pair | What is held equal | What differs |
| --- | --- | --- |
| `pair-a` / `pair-b` | period 218.1818 smp (220 Hz) | partial-5 T60 2.60 vs 2.44 s |
| `pair-c` / `pair-d` | fundamental T60 1.52 vs 1.47 s (3.3%) | period 244.90 vs 194.38 smp (a major third) |

Pair 1 separates pitch from brightness: identical measured period, measurably
different decay. Pair 2 is the trap for the reverse inference — nearly equal
tails, very different pitch. `loss-phase-drift` holds N and the allpass
coefficient and changes only λ, and the period moves anyway.
`rate-boundary-44k1` / `rate-boundary-48k` render the same nominal note at two
rates; at 44.1 kHz the solved integer delay is 0.0073 samples from stepping to
the next integer, at 48 kHz it is 0.4207. `short-tail-indeterminate` exists to
prove the generator refuses to stamp a number on a tail it cannot fit.

Generated output lives in `examples/reference/`: `examples.json` (all
measurements and the exact fit spans), `conventions.json`, and two retained
16-bit recordings of the v2 presets.

### What the filter change broke

The loss filter was `L(z)²` (two stages) in v2 and is `L(z)` (one stage) now.
`conventions.json` and the library panel re-test each old claim against
rendered audio:

| Old convention | Verdict |
| --- | --- |
| Loss phase contributes `2·phaseDelay(L, ω₀)` | **broken** — it contributes once |
| The same λ sets the same partial-5/fundamental ratio | **broken** — 0.8672 (L²) vs 0.9289 (L) |
| The auto damping curve keeps its timbre | holds — 0.8672 vs 0.8680 |
| The solved integer delay N is still correct | holds — N=217 under both |
| A stored (N, a) keeps its pitch | **broken** — 0.70 cents off |
| λ can always be raised to match the old profile | **broken** — saturates at 880 Hz |

### Retained recordings catch a bad conversion

The conversion is not "translate the parameter". The retained `legacy-*.wav`
recordings are decoded, their partial T60s measured from the audio, and a
single-stage λ fitted to *those measurements*. The generator renders both the
naive carry-over and the converted λ and requires the converted render to land
within a few percent of the recording while the naive one does not. For
`legacy-a3-v2`, λ 0.0884 → 0.2030; partial-5 is 2.601 s in the recording,
2.787 s carried, 2.600 s converted.

## Verify

```bash
npm test                         # 157 kernel/measurement checks, no browser
npm run examples:generate        # re-render and re-measure the library
npm run examples:check           # verify targets without writing
npm run render -- --f 220 --t60 3 --out output/reference
npm run test:browser             # headless Chromium, needs Playwright
npm run test:matrix              # six UI configurations end to end
```

`model-tests.js` covers pitch accuracy across 41 Hz–2 kHz at two sample
rates, T60 configuration sweeps, partial decay vs. prediction, modal nulls for
pluck/pickup positions, energy monotonicity, stability under a continuous
parameter sweep, and rejection of invalid requests. It also checks the
measurement layer itself: a period CI is finite and the fit span is reported,
a short tail stays indeterminate with a reason, a flat line never becomes a
T60, the library's pairs and rate-boundary targets hold, carrying a stored λ
misses the retained recording while the fitted conversion matches it, and a
16-bit WAV round trip does not bias the decay.

`browser-check.js` drives the actual UI: starts audio, plucks, captures the
worklet output, measures pitch and decay, retunes by changing length, checks
that an invalid pitch surfaces an error, and exercises the offline renderer
and WAV download.

The `scripts/serve.js` and test scripts were run in this environment. In this
sandbox Chromium needs its bundled libraries on the loader path; extract the
Debian bookworm `arm64` packages for `libnss3` (with `libnspr4`) and the
X/ATK/GBM set into one directory, then set
`LD_LIBRARY_PATH=<dir>/usr/lib/aarch64-linux-gnu:<dir>/lib/aarch64-linux-gnu`
before the browser commands. On a normal desktop Playwright resolves them
itself.
