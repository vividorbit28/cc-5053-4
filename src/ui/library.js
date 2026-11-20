/*
 * Example-library and preset-maintenance panels.
 *
 * The library reads the JSON written by `scripts/generate-examples.js` and
 * shows what the generator actually measured: the base period with its 95%
 * CI, each partial's T60, and the exact span of audio the fits used.  A case
 * whose tail was too short to fit stays in the table with its reason, not
 * with a stand-in number.
 *
 * The maintenance panel is the reverse direction.  It loads a retained
 * recording of a v2 (two-stage loss) preset, measures the recorded partial
 * decay from that audio, fits a single-stage λ to those measurements, and
 * renders carried-over vs converted versions for comparison.  Acceptance is
 * against the recording, so an incorrect conversion is caught by sound.
 */

import {
  measureFundamentalPeriod,
  measurePartialDecay,
  fitDecayLine
} from '../core/analysis.js';
import { fitLambdaToProfile } from '../core/conversion.js';
import { renderString, encodeWav } from '../core/offline.js';

const REF = new URL('../../examples/reference/', import.meta.url);
const PARTIALS = [1, 2, 4, 5];
const PAIR_LABELS = {
  'same-f0-different-decay': 'Pair 1 — same pitch, different decay',
  'matched-tail-different-pitch': 'Pair 2 — matched tail, different pitch',
  'nominal-pitch-across-rates': 'Same nominal pitch, two sample rates',
  'loss-phase-changes-pitch': 'Loss phase moves the pitch'
};

const state = {
  data: null,
  conventions: null,
  filter: 'all',
  plots: [],
  applied: null,
  applyPreset: null,
  convertedWavUrl: null,
  maintenance: null
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setChip(id, text, tone = null) {
  const chip = $(id);
  if (!chip) return;
  const textEl = chip.querySelector('[data-text]') || chip;
  textEl.textContent = text;
  if (tone) chip.dataset.tone = tone;
  else delete chip.dataset.tone;
}

/* ─────────────────────────── formatting ─────────────────────────────── */

function fmtValue(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function fmtCI(ci) {
  if (!Number.isFinite(ci)) return '± —';
  if (ci === 0) return '± 0';
  if (ci < 1e-4) return '± ' + ci.toExponential(1);
  return '± ' + ci.toFixed(4);
}

function fmtSpan(start, end) {
  return Number.isFinite(start) && Number.isFinite(end)
    ? start.toFixed(2) + '–' + end.toFixed(2) + ' s'
    : '—';
}

function isMeasured(c, key = 'period') {
  return key === 'period'
    ? c.measured.pitchStatus === 'measured'
    : c.measured.overallT60Status === 'measured';
}

function caseIsIndeterminate(c) {
  return !isMeasured(c, 'period') || !isMeasured(c, 'decay') ||
    c.partials.some(p => p.status !== 'measured');
}

function findPartial(c, k) {
  return c.partials.find(p => p.harmonic === k) || null;
}

function caseNote(c) {
  return c.note || c.id;
}

/* ─────────────────────────── library table ──────────────────────────── */

function renderPairs(cases) {
  const host = $('libraryPairs');
  host.innerHTML = '';
  const groups = new Map();
  for (const c of cases) {
    if (!c.pair) continue;
    if (!groups.has(c.pair)) groups.set(c.pair, []);
    groups.get(c.pair).push(c);
  }
  for (const [pair, members] of groups) {
    // The loss-phase case gets its own card below; it is not a pair.
    if (pair === 'loss-phase-changes-pitch') continue;
    const card = el('div', 'pair-card');
    card.appendChild(el('h3', null, PAIR_LABELS[pair] || pair));
    card.appendChild(el('p', null, pairDescription(pair, members)));
    const verdict = pairVerdict(pair, members);
    card.appendChild(el('div', 'pair-verdict ' + verdict.tone, verdict.text));
    host.appendChild(card);
  }

  // The loss-phase case is not a pair, but it is the third demonstration:
  // N and the allpass are fixed while λ changes, and the pitch moves anyway.
  const drift = cases.find(c => c.lossPhaseDrift);
  if (drift) {
    const card = el('div', 'pair-card');
    card.appendChild(el('h3', null, PAIR_LABELS['loss-phase-changes-pitch']));
    const d = drift.lossPhaseDrift;
    card.appendChild(el('p', null,
      'N = ' + d.heldIntegerDelay + ' and a = ' + d.heldAllpass.toFixed(4) +
      ' are held fixed; λ goes ' + d.lambdaFrom + ' → ' + d.lambdaTo + '.'));
    card.appendChild(el('div', 'pair-verdict warn',
      'measured ' + (Number.isFinite(d.measuredPeriod) ? d.measuredPeriod.toFixed(4) : '—') +
      ' smp (' + d.shiftCents.toFixed(2) + ' cents; expected ' +
      d.expectedShiftCents.toFixed(2) + ')'));
    host.appendChild(card);
  }
}

function pairDescription(pair, members) {
  const [a, b] = members;
  if (!a || !b) return 'Single case.';
  if (pair === 'same-f0-different-decay') {
    return 'Both tuned to the same nominal pitch; the second uses a much heavier loss so ' +
      'its partials die sooner. The pair separates pitch from brightness.';
  }
  if (pair === 'matched-tail-different-pitch') {
    return 'Fundamental T60s are within a few percent, yet the base periods differ by ' +
      'a major third. An analyser that infers pitch from decay will confuse them.';
  }
  if (pair === 'nominal-pitch-across-rates') {
    return 'The same nominal note rendered at two rates. At ' + (a.config.sampleRate / 1000).toFixed(1) +
      ' kHz the solved integer delay sits ' + nearestBoundary(a) + ' samples from stepping to the ' +
      'next integer; at ' + (b.config.sampleRate / 1000).toFixed(1) + ' kHz it is ' +
      nearestBoundary(b) + ' samples away.';
  }
  return '';
}

function pairVerdict(pair, members) {
  const [a, b] = members;
  if (!a || !b) return { tone: 'warn', text: 'single case' };
  if (pair === 'same-f0-different-decay') {
    const pA = a.measured.periodSamples;
    const pB = b.measured.periodSamples;
    const dA = findPartial(a, 5);
    const dB = findPartial(b, 5);
    if (!Number.isFinite(pA) || !Number.isFinite(pB)) {
      return { tone: 'warn', text: 'period not measurable for both members' };
    }
    const periodDelta = Math.abs(pA - pB);
    const t60A = dA ? dA.measuredT60 : NaN;
    const t60B = dB ? dB.measuredT60 : NaN;
    const tone = periodDelta < 0.01 && Number.isFinite(t60A) && Number.isFinite(t60B) && t60A - t60B > 0.05
      ? 'good' : 'bad';
    return {
      tone,
      text: 'Δperiod ' + periodDelta.toExponential(1) + ' smp · partial-5 T60 ' +
        fmtValue(t60A, 3) + ' vs ' + fmtValue(t60B, 3) + ' s'
    };
  }
  if (pair === 'matched-tail-different-pitch') {
    const tA = a.measured.overallT60;
    const tB = b.measured.overallT60;
    const pA = a.measured.periodSamples;
    const pB = b.measured.periodSamples;
    if (!Number.isFinite(pA) || !Number.isFinite(pB)) {
      return { tone: 'warn', text: 'period not measurable for both members' };
    }
    const semitones = Math.abs(12 * Math.log2(pA / pB));
    const tailDelta = Math.abs(tA - tB) / Math.max(tA, tB);
    const tone = semitones > 1.5 && tailDelta < 0.1 ? 'good' : 'bad';
    return {
      tone,
      text: 'Δpitch ' + semitones.toFixed(2) + ' semitones · Δtail ' +
        (tailDelta * 100).toFixed(1) + '%'
    };
  }
  if (pair === 'nominal-pitch-across-rates') {
    const same = Math.abs(a.measured.periodSamples / a.config.sampleRate -
      b.measured.periodSamples / b.config.sampleRate) < 1e-6;
    const boundaryA = nearestBoundaryValue(a);
    const tone = same && boundaryA < 0.02 ? 'good' : 'warn';
    return {
      tone,
      text: 'Δperiod ' + Math.abs(a.measured.periodSamples - b.measured.periodSamples).toFixed(4) +
        ' smp · closest boundary ' + boundaryA.toFixed(4) + ' smp'
    };
  }
  return { tone: 'warn', text: '—' };
}

function nearestBoundaryValue(c) {
  return Number.isFinite(c.solved.boundaryDistance) ? c.solved.boundaryDistance : Infinity;
}

function nearestBoundary(c) {
  const d = nearestBoundaryValue(c);
  return Number.isFinite(d) ? d.toFixed(4) : '—';
}

function visibleCases() {
  const all = state.data ? state.data.cases : [];
  switch (state.filter) {
    case 'pairs':
      return all.filter(c => c.pair === 'same-f0-different-decay' ||
        c.pair === 'matched-tail-different-pitch');
    case 'rate':
      return all.filter(c => c.pair === 'nominal-pitch-across-rates');
    case 'indeterminate':
      return all.filter(caseIsIndeterminate);
    default:
      return all;
  }
}

function renderTable() {
  const body = $('libraryBody');
  body.innerHTML = '';
  const cases = visibleCases();
  for (const c of cases) {
    const row = el('tr', isMeasured(c, 'period') && isMeasured(c, 'decay') ? '' : 'state-indeterminate');

    const name = el('td', 'case-name');
    name.appendChild(document.createTextNode(c.role ? c.role + ' · ' : ''));
    name.appendChild(document.createTextNode(c.id));
    name.appendChild(el('small', null, caseNote(c)));
    row.appendChild(name);

    const periodCell = el('td');
    if (isMeasured(c, 'period')) {
      periodCell.appendChild(document.createTextNode(fmtValue(c.measured.periodSamples, 4)));
      periodCell.appendChild(el('span', 'ci', ' ' + fmtCI(c.measured.periodCI)));
    } else {
      periodCell.textContent = '—';
      periodCell.appendChild(el('div', 'reason', c.measured.pitchReason || 'indeterminate'));
    }
    row.appendChild(periodCell);

    const f0Cell = el('td');
    if (isMeasured(c, 'period')) {
      const f0 = c.config.frequency * Math.pow(2, c.measured.cents / 1200);
      f0Cell.textContent = fmtValue(f0, 2) + ' Hz';
      f0Cell.appendChild(el('div', 'ci', (c.measured.cents >= 0 ? '+' : '') +
        fmtValue(c.measured.cents, 3) + ' cents'));
    } else {
      f0Cell.textContent = '—';
    }
    row.appendChild(f0Cell);

    const t60Cell = el('td');
    if (isMeasured(c, 'decay')) {
      t60Cell.textContent = 'T60 ' + fmtValue(c.measured.overallT60, 2) + ' s';
      t60Cell.appendChild(el('div', 'ci', fmtCI(c.measured.overallT60CI)));
      if (c.partials.length) {
        const parts = c.partials.map(p =>
          'k' + p.harmonic + ' ' + (p.status === 'measured' ? fmtValue(p.measuredT60, 2) : '—'));
        t60Cell.appendChild(el('div', 'ci', parts.join(' · ')));
      }
    } else {
      t60Cell.textContent = '—';
      t60Cell.appendChild(el('div', 'reason', c.measured.overallT60Status === 'indeterminate'
        ? c.measured.overallReason || 'tail too short' : 'undetermined'));
    }
    row.appendChild(t60Cell);

    const spanCell = el('td');
    spanCell.textContent = fmtSpan(c.measured.pitchFitStart, c.measured.pitchFitEnd);
    spanCell.appendChild(el('div', 'ci', 'decay ' +
      fmtSpan(c.measured.overallT60FitStart, c.measured.overallT60FitEnd)));
    row.appendChild(spanCell);

    const stateCell = el('td');
    const pitchOk = isMeasured(c, 'period');
    const decayOk = isMeasured(c, 'decay');
    const badge = el('span', 'state ' + (pitchOk && decayOk ? 'measured' : 'indeterminate'),
      pitchOk && decayOk ? 'measured' : 'indeterminate');
    stateCell.appendChild(badge);
    row.appendChild(stateCell);

    body.appendChild(row);
  }
  if (!cases.length) {
    const row = el('tr');
    const cell = el('td');
    cell.colSpan = 6;
    cell.className = 'note';
    cell.textContent = 'No cases match this filter.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  const all = state.data ? state.data.cases : [];
  const measured = all.filter(c => isMeasured(c, 'period') && isMeasured(c, 'decay')).length;
  const open = all.length - measured;
  $('librarySummary').textContent =
    all.length + ' cases · ' + measured + ' fully measured · ' + open + ' indeterminate' +
    ' · showing ' + cases.length;
}

/* ───────────────────────────── plots ────────────────────────────────── */

function canvas2d(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function plotAxes(ctx, width, height, pad) {
  ctx.strokeStyle = '#1c232b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, height - pad.b);
  ctx.lineTo(width - pad.r, height - pad.b);
  ctx.stroke();
}

function attachPlot(caseData, canvas, kind) {
  const draw = () => {
    const setup = canvas2d(canvas);
    if (!setup) return;
    if (kind === 'phase') drawPhasePlot(setup.ctx, setup.width, setup.height, caseData);
    else drawDecayPlot(setup.ctx, setup.width, setup.height, caseData);
  };
  state.plots.push(draw);
  draw();
}

/*
 * Period-versus-tail curve.  The y-axis is the *local* period implied by the
 * fitted phase line over a short window, i.e. 2π/(dφ/dt) evaluated around
 * each sample.  It is drawn beside the reported period and its CI so the flat
 * phase fit is visibly a fit, not a description of the pluck transient (which
 * would show as a big spike at the start if raw block phases were used).
 */
function drawPhasePlot(ctx, width, height, c) {
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const measured = isMeasured(c, 'period');
  const points = c.measured.pitchPhasePoints || [];
  const fs = c.config.sampleRate;
  const slope = c.measured.pitchPhaseSlope;

  const raw = [];
  if (points.length >= 3 && Number.isFinite(slope)) {
    // Local slope over a 5-sample window, converted to a frequency offset from
    // the nominal analysis frequency, then to a period in samples.
    const half = 2;
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - half)];
      const b = points[Math.min(points.length - 1, i + half)];
      const dt = b[0] - a[0];
      if (!(dt > 0)) continue;
      const localSlope = (b[1] - a[1]) / dt;
      const f = c.config.frequency + localSlope / (2 * Math.PI);
      if (f > 0) raw.push({ t: points[i][0], period: fs / f });
    }
  }
  // The first block or two can be pulled by the pluck transient.  Discard
  // points more than 5% away from the median local period — and say how many
  // were dropped rather than silently clipping the curve.
  const running = trimOutliers(raw, 0.05);

  const values = running.map(r => r.period).filter(Number.isFinite);
  if (measured && Number.isFinite(c.measured.periodCI)) {
    values.push(c.measured.periodSamples + c.measured.periodCI,
      c.measured.periodSamples - c.measured.periodCI);
  }
  if (!values.length) {
    plotAxes(ctx, width, height, pad);
    ctx.fillStyle = '#e8b24a';
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(c.measured.pitchReason || 'indeterminate', width / 2, height / 2 - 4);
    ctx.fillStyle = '#5b6673';
    ctx.fillText('kept as an indeterminate sample', width / 2, height / 2 + 10);
    return;
  }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-6) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; }
  const margin = Math.max(1e-6, (hi - lo) * 0.25);
  lo -= margin;
  hi += margin;
  const tMin = points.length ? points[0][0] : c.measured.pitchFitStart;
  const tMax = points.length ? points[points.length - 1][0] : c.measured.pitchFitEnd;
  const tSpan = Math.max(1e-6, tMax - tMin);
  const x = (t) => pad.l + (t - tMin) / tSpan * plotW;
  const y = (period) => pad.t + (hi - period) / (hi - lo) * plotH;

  // The span of audio the fit used, shaded.
  if (Number.isFinite(c.measured.pitchFitStart) && Number.isFinite(c.measured.pitchFitEnd)) {
    ctx.fillStyle = 'rgba(122, 167, 255, 0.06)';
    ctx.fillRect(x(c.measured.pitchFitStart), pad.t,
      Math.max(2, x(c.measured.pitchFitEnd) - x(c.measured.pitchFitStart)), plotH);
  }

  // Reported period and its 95% CI.  A sub-sample CI is drawn at least 1.5 px
  // tall so the interval stays visible rather than vanishing into the line.
  if (measured) {
    const p = c.measured.periodSamples;
    const ci = Number.isFinite(c.measured.periodCI) ? c.measured.periodCI : 0;
    const y0 = y(p + ci);
    const y1 = y(p - ci);
    ctx.fillStyle = 'rgba(111, 211, 161, 0.18)';
    ctx.fillRect(pad.l, Math.min(y0, y1), plotW, Math.max(1.5, Math.abs(y1 - y0)));
    ctx.strokeStyle = 'rgba(111, 211, 161, 0.9)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y(p));
    ctx.lineTo(width - pad.r, y(p));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  plotAxes(ctx, width, height, pad);
  const pts = running.map(r => [x(r.t), y(r.period)]);
  if (pts.length > 1) {
    ctx.strokeStyle = '#7aa7ff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  ctx.fillStyle = '#5b6673';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtValue(hi, 3), 2, pad.t + 8);
  ctx.fillText(fmtValue(lo, 3), 2, height - pad.b);
  ctx.textAlign = 'right';
  ctx.fillText(tMax.toFixed(2) + ' s', width - pad.r, height - 5);

  ctx.textAlign = 'left';
  if (measured) {
    ctx.fillStyle = '#6fd3a1';
    ctx.fillText('P = ' + fmtValue(c.measured.periodSamples, 4) + ' ' +
      fmtCI(c.measured.periodCI) + ' smp', pad.l + 4, pad.t + 9);
  } else {
    ctx.fillStyle = '#e8b24a';
    ctx.fillText('indeterminate', pad.l + 4, pad.t + 9);
  }
}

function trimOutliers(points, limit) {
  if (points.length < 3) return points;
  const sorted = points.map(p => p.period).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return points.filter(p => Math.abs(p.period / median - 1) <= limit);
}

function drawRawWindows(ctx, width, height, pad, points) {
  if (!points.length) return;
  const tMin = points[0][0];
  const tMax = points[points.length - 1][0];
  const dbMin = Math.min(...points.map(p => p[1]));
  const dbMax = Math.max(...points.map(p => p[1]));
  const spanDb = Math.max(1, dbMax - dbMin);
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  for (const [t, db] of points) {
    const x = pad.l + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 0.5) * plotW;
    const y = pad.t + (dbMax - db) / spanDb * plotH;
    ctx.fillStyle = '#e4b45f';
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
}

function drawDecayPlot(ctx, width, height, c) {
  const pad = { l: 30, r: 8, t: 8, b: 18 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const points = c.measured.overallDecayPoints || [];
  const measured = isMeasured(c, 'decay');

  // An unfitted pair of windows is not a decay curve.  Draw the windows that
  // were kept as raw samples so the retained evidence is visible, but never
  // draw a trend line through them.
  if (!measured || points.length < 2) {
    plotAxes(ctx, width, height, pad);
    drawRawWindows(ctx, width, height, pad, points);
    ctx.fillStyle = '#e8b24a';
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(c.measured.overallReason || c.measured.overallT60Status || 'tail too short to fit',
      width / 2, height / 2 - 4);
    ctx.fillStyle = '#5b6673';
    ctx.fillText(points.length + ' windows kept — no fit drawn', width / 2, height / 2 + 10);
    return;
  }

  const tMin = points[0][0];
  const tMax = points[points.length - 1][0];
  const dbValues = points.map(p => p[1]);
  let dbMin = Math.min(...dbValues);
  let dbMax = Math.max(...dbValues);
  const padDb = Math.max(3, (dbMax - dbMin) * 0.1);
  dbMin -= padDb;
  dbMax += padDb;
  const x = (t) => pad.l + (t - tMin) / Math.max(1e-6, tMax - tMin) * plotW;
  const y = (db) => pad.t + (dbMax - db) / (dbMax - dbMin) * plotH;

  // The exact span the fit used.
  if (Number.isFinite(c.measured.overallT60FitStart) && Number.isFinite(c.measured.overallT60FitEnd)) {
    const x0 = x(c.measured.overallT60FitStart);
    const x1 = x(c.measured.overallT60FitEnd);
    ctx.fillStyle = 'rgba(111, 211, 161, 0.09)';
    ctx.fillRect(x0, pad.t, Math.max(2, x1 - x0), plotH);
    ctx.strokeStyle = 'rgba(111, 211, 161, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, pad.t);
    ctx.lineTo(x0, pad.t + plotH);
    ctx.moveTo(x1, pad.t);
    ctx.lineTo(x1, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  plotAxes(ctx, width, height, pad);

  const pts = points.map(([t, db]) => [x(t), y(db)]);
  ctx.strokeStyle = '#e4b45f';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.fillStyle = '#e4b45f';
  for (const p of pts) ctx.fillRect(p[0] - 1.2, p[1] - 1.2, 2.4, 2.4);

  // Fitted line over the tail actually used.
  const fitPoints = points
    .filter(([t]) => t >= c.measured.overallT60FitStart - 1e-9 && t <= c.measured.overallT60FitEnd + 1e-9)
    .map(([t, db]) => ({ t, db }));
  const fit = fitDecayLine(fitPoints);
  if (fit.status === 'measured' && Number.isFinite(fit.slope)) {
    const t0 = fitPoints[0].t;
    const t1 = fitPoints[fitPoints.length - 1].t;
    ctx.strokeStyle = 'rgba(111, 211, 161, 0.95)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x(t0), y(fit.intercept + fit.slope * t0));
    ctx.lineTo(x(t1), y(fit.intercept + fit.slope * t1));
    ctx.stroke();
  }

  ctx.fillStyle = '#5b6673';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtValue(dbMax, 0) + ' dB', 1, pad.t + 8);
  ctx.fillText(fmtValue(dbMin, 0), 1, height - pad.b);
  ctx.textAlign = 'right';
  ctx.fillText(tMax.toFixed(2) + ' s', width - pad.r, height - 5);

  ctx.textAlign = 'left';
  if (measured) {
    ctx.fillStyle = '#6fd3a1';
    ctx.fillText('T60 ' + fmtValue(c.measured.overallT60, 2) + ' ' +
      fmtCI(c.measured.overallT60CI) + ' s', pad.l + 4, pad.t + 9);
  } else {
    ctx.fillStyle = '#e8b24a';
    ctx.fillText('indeterminate — ' + (c.measured.overallReason || 'tail too short'), pad.l + 4, pad.t + 9);
  }
}

function renderPlots() {
  const host = $('libraryPlots');
  host.innerHTML = '';
  state.plots = [];
  for (const c of visibleCases()) {
    const card = el('div', 'plot-card');
    card.appendChild(el('h4', null, (c.role ? c.role + ' · ' : '') + c.id));

    const phase = el('canvas');
    phase.setAttribute('aria-label', 'Measured period versus fit tail for ' + c.id);
    card.appendChild(phase);
    card.appendChild(el('div', 'plot-caption', phaseCaption(c)));

    const decay = el('canvas');
    decay.setAttribute('aria-label', 'Measured decay and fit tail for ' + c.id);
    card.appendChild(decay);
    card.appendChild(el('div', 'plot-caption', decayCaption(c)));

    host.appendChild(card);
    attachPlot(c, phase, 'phase');
    attachPlot(c, decay, 'decay');
  }
}

function phaseCaption(c) {
  if (!isMeasured(c, 'period')) return 'no period — ' + (c.measured.pitchReason || 'indeterminate');
  return 'period ' + fmtValue(c.measured.periodSamples, 4) + ' ' + fmtCI(c.measured.periodCI) +
    ' smp · fit tail ' + fmtSpan(c.measured.pitchFitStart, c.measured.pitchFitEnd);
}

function decayCaption(c) {
  if (!isMeasured(c, 'decay')) return 'no T60 — ' + (c.measured.overallReason || 'tail too short');
  return 'T60 ' + fmtValue(c.measured.overallT60, 3) + ' ' + fmtCI(c.measured.overallT60CI) +
    ' s · fit tail ' + fmtSpan(c.measured.overallT60FitStart, c.measured.overallT60FitEnd);
}

/* ──────────────────── retained recording / conversion ─────────────────── */

function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let format = null;
  let dataOffset = null;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataOffset == null) throw new Error('WAV missing fmt or data chunk');
  if (format.audioFormat !== 1 || format.bits !== 16 || format.channels !== 1) {
    throw new Error('expected 16-bit mono PCM, got format ' + format.audioFormat +
      ' / ' + format.bits + ' bit / ' + format.channels + ' ch');
  }
  const count = Math.floor(dataLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000;
  }
  return { samples, sampleRate: format.sampleRate };
}

function measureProfile(samples, fs, f0) {
  const out = {};
  for (const k of PARTIALS) {
    if (f0 * k >= fs * 0.45) continue;
    out[k] = measurePartialDecay(samples, f0 * k, fs, {
      startSeconds: 0.05,
      windowSeconds: 0.18
    });
  }
  return out;
}

function profileTargets(profile) {
  return Object.entries(profile)
    .filter(([, p]) => p && p.status === 'measured')
    .map(([k, p]) => ({ k: Number(k), t60: p.t60 }));
}

function relativeError(profileA, profileB, k) {
  const a = profileA[k];
  const b = profileB[k];
  if (!a || !b || a.status !== 'measured' || b.status !== 'measured') return NaN;
  return Math.abs(b.t60 - a.t60) / a.t60;
}

async function loadRecording(preset) {
  const response = await fetch(new URL(preset.id + '.wav', REF));
  if (!response.ok) throw new Error('could not load ' + preset.id + '.wav (' + response.status + ')');
  return decodeWav(new Uint8Array(await response.arrayBuffer()));
}

function presetLabel(preset) {
  return preset.label || preset.id;
}

function populatePresets() {
  const host = $('maintPreset');
  host.innerHTML = '';
  const presets = state.data ? state.data.legacyPresets : [];
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = presetLabel(preset);
    host.appendChild(option);
  }
  $('maintCompare').disabled = presets.length === 0;
  $('maintWav').classList.add('disabled');
  $('maintWav').setAttribute('aria-disabled', 'true');
  $('maintWav').removeAttribute('href');
  $('maintRecordings').innerHTML = '';
  if (!presets.length) return;
  const note = el('div');
  note.appendChild(document.createTextNode('Retained recordings (measured, not re-rendered): '));
  presets.forEach((preset, index) => {
    if (index) note.appendChild(document.createTextNode(' · '));
    const link = el('a', null, preset.id + '.wav');
    link.href = new URL(preset.id + '.wav', REF).href;
    link.target = '_blank';
    link.rel = 'noopener';
    note.appendChild(link);
  });
  $('maintRecordings').appendChild(note);
}

function maintCard(title, tone, rows, note) {
  const card = el('div', 'maint-card' + (tone ? ' ' + tone : ''));
  card.appendChild(el('h4', null, title));
  const dl = el('dl');
  for (const [key, value] of rows) {
    const row = el('div');
    row.appendChild(el('dt', null, key));
    row.appendChild(el('dd', null, value));
    dl.appendChild(row);
  }
  card.appendChild(dl);
  if (note) card.appendChild(el('div', 'maint-note', note));
  return card;
}

async function runComparison() {
  const presetId = $('maintPreset').value;
  const preset = (state.data.legacyPresets || []).find(p => p.id === presetId);
  if (!preset) return;

  const compare = $('maintCompare');
  compare.disabled = true;
  compare.textContent = 'Rendering…';
  setChip('maintChip', 'measuring…', 'warn');
  $('maintApply').disabled = true;
  state.maintenance = null;
  state.applied = null;
  if (window.__tautString) window.__tautString.maintenance = null;
  const output = $('maintOutput');
  output.innerHTML = '';
  output.appendChild(el('p', 'note', 'Loading the retained recording…'));

  await new Promise(r => setTimeout(r, 20));

  try {
    const cfg = preset.config;
    const fs = cfg.sampleRate;
    const f0 = cfg.frequency;

    const recording = await loadRecording(preset);
    if (recording.sampleRate !== fs) {
      throw new Error('recording is ' + recording.sampleRate + ' Hz, preset says ' + fs + ' Hz');
    }

    // The target is the recording's measured profile.
    const recordedPartials = measureProfile(recording.samples, fs, f0);
    const recordedPitch = measureFundamentalPeriod(recording.samples, f0, fs);
    const targets = profileTargets(recordedPartials);
    if (!targets.length) throw new Error('no measured partials in the retained recording');
    const conv = fitLambdaToProfile(f0, fs, cfg.t60, targets);

    // Carried forward unchanged (stored λ, current single stage) versus the
    // converted λ fitted to the recording.
    const carriedRender = renderString({ ...cfg, lossStages: 1 });
    const convertedRender = renderString({ ...cfg, lossLambda: conv.lambda, lossStages: 1 });
    const carriedPartials = measureProfile(carriedRender.samples, fs, f0);
    const convertedPartials = measureProfile(convertedRender.samples, fs, f0);
    const carriedPitch = measureFundamentalPeriod(carriedRender.samples, f0, fs);
    const convertedPitch = measureFundamentalPeriod(convertedRender.samples, f0, fs);

    const k = 5;
    const carriedErr = relativeError(recordedPartials, carriedPartials, k);
    const convertedErr = relativeError(recordedPartials, convertedPartials, k);
    const accepted = conv.acceptanceTolerance !== Infinity
      ? convertedErr < conv.acceptanceTolerance
      : convertedErr < 0.05;
    const pitchDelta = Math.abs(convertedPitch.cents ?? Infinity);
    const carriedIsWrong = !(carriedErr < 0.03);

    const partialValue = (profile) => profile[k] && profile[k].status === 'measured'
      ? fmtValue(profile[k].t60, 3) + ' s'
      : '—';
    const pitchValue = (measured) => measured.status === 'measured'
      ? fmtValue(measured.cents, 3) + ' cents'
      : 'indeterminate';

    output.innerHTML = '';
    const grid = el('div', 'maint-grid');
    grid.appendChild(maintCard('Retained recording', 'recorded', [
      ['stored λ', fmtValue(cfg.lossLambda, 4) + ' (two-stage loop)'],
      ['partial-5 T60', partialValue(recordedPartials)],
      ['pitch', pitchValue(recordedPitch)]
    ], 'Measured from ' + preset.id + '.wav — the reference, not the source numbers.'));

    grid.appendChild(maintCard('Carried forward', null, [
      ['λ', fmtValue(cfg.lossLambda, 4) + ' (unchanged)'],
      ['partial-5 T60', partialValue(carriedPartials)],
      ['vs recording', fmtSignedPercent(carriedErr)],
      ['pitch', pitchValue(carriedPitch)]
    ], 'Same stored parameters under the single-stage filter.'));

    grid.appendChild(maintCard('Converted', 'converted', [
      ['λ', fmtValue(conv.lambda, 4) + (conv.limited ? ' (capped)' : '')],
      ['partial-5 T60', partialValue(convertedPartials)],
      ['vs recording', fmtSignedPercent(convertedErr)],
      ['pitch', pitchValue(convertedPitch)]
    ], 'λ fitted to the recorded partial decay, then re-rendered and re-measured.'));

    output.appendChild(grid);

    const verdictTone = accepted && pitchDelta < 1 && carriedIsWrong ? 'good' : 'bad';
    const verdictText = accepted && pitchDelta < 1
      ? 'Converted sound reproduces the retained recording: partial-5 is ' +
        fmtSignedPercent(convertedErr) + ', pitch ' + pitchDelta.toFixed(3) +
        ' cents off. The unchanged λ misses by ' + fmtSignedPercent(carriedErr) +
        ', which is what the recording catches.'
      : 'Conversion does not reproduce the retained recording (partial-5 ' +
        fmtSignedPercent(convertedErr) + ', pitch ' + (Number.isFinite(pitchDelta) ? pitchDelta.toFixed(2) : '—') +
        ' cents).';
    output.appendChild(el('div', 'maint-verdict ' + verdictTone, verdictText));

    try {
      const wavLink = $('maintWav');
      if (state.convertedWavUrl) URL.revokeObjectURL(state.convertedWavUrl);
      const wav = encodeWav(convertedRender.samples, fs);
      state.convertedWavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      wavLink.href = state.convertedWavUrl;
      wavLink.download = preset.id + '-converted.wav';
      wavLink.classList.remove('disabled');
      wavLink.setAttribute('aria-disabled', 'false');
    } catch {
      // Download links need Blob URLs; the measurement report does not.
      state.convertedWavUrl = null;
    }

    state.maintenance = {
      preset: preset.id,
      convertedLambda: conv.lambda,
      limited: conv.limited,
      acceptanceTolerance: conv.acceptanceTolerance,
      recorded: serialiseProfile(recordedPartials),
      carried: serialiseProfile(carriedPartials),
      converted: serialiseProfile(convertedPartials),
      recordedPitchCents: recordedPitch.cents,
      carriedPitchCents: carriedPitch.cents,
      convertedPitchCents: convertedPitch.cents,
      carriedRelativeError: carriedErr,
      convertedRelativeError: convertedErr,
      accepted: accepted && pitchDelta < 1,
      carriedCaught: carriedIsWrong
    };
    if (window.__tautString) window.__tautString.maintenance = state.maintenance;

    $('maintApply').disabled = false;
    state.applied = {
      frequency: f0,
      sampleRate: fs,
      t60: cfg.t60,
      lambda: conv.lambda,
      pluckPosition: cfg.pluckPosition,
      pickupPosition: cfg.pickupPosition
    };
    setChip('maintChip', accepted ? 'converted · verified' : 'converted · mismatch',
      accepted ? 'good' : 'bad');
  } catch (err) {
    output.innerHTML = '';
    output.appendChild(el('p', 'note', 'Comparison failed: ' + (err.message || err)));
    setChip('maintChip', 'load failed', 'bad');
  } finally {
    compare.disabled = false;
    compare.textContent = 'Render comparison';
  }
}

function serialiseProfile(profile) {
  const out = {};
  for (const [k, p] of Object.entries(profile)) {
    out[k] = { t60: p.t60, ci: p.t60CI, status: p.status, reason: p.reason };
  }
  return out;
}

function fmtSignedPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + (value * 100).toFixed(1) + '%';
}

/* ──────────────────── broken conventions from the filter change ────────── */

function renderConventions() {
  const host = $('libraryPairs');
  const data = state.conventions && state.conventions.conventions;
  if (!host || !data || !data.length) return;
  const card = el('div', 'pair-card');
  card.appendChild(el('h3', null, 'Filter change: which v2 conventions still hold'));
  for (const c of data) {
    const line = el('div', 'pair-verdict ' + (c.holds ? 'good' : 'bad'),
      (c.holds ? 'HOLDS ' : 'BROKEN ') + c.claim + ' — ' + c.evidence);
    card.appendChild(line);
  }
  card.appendChild(el('p', null,
    'Measured against rendered audio after the loss filter changed from L² to L.'));
  host.appendChild(card);
}

/* ───────────────────────────── boot ─────────────────────────────────── */

export async function initLibrary({ applyPreset } = {}) {
  state.applyPreset = applyPreset || null;
  $('libraryFilter').addEventListener('change', (event) => {
    state.filter = event.target.value;
    renderTable();
    renderPlots();
  });
  $('maintCompare').addEventListener('click', runComparison);
  $('maintApply').addEventListener('click', () => {
    if (!state.maintenance || !state.applyPreset) return;
    state.applyPreset(state.applied, state.maintenance);
  });

  let data;
  let conventions;
  try {
    const [dataRes, convRes] = await Promise.all([
      fetch(new URL('examples.json', REF)),
      fetch(new URL('conventions.json', REF))
    ]);
    if (!dataRes.ok) throw new Error('examples.json: HTTP ' + dataRes.status);
    data = await dataRes.json();
    conventions = convRes.ok ? await convRes.json() : null;
  } catch (err) {
    setChip('libraryChip', 'library unavailable', 'bad');
    $('librarySummary').textContent = 'Could not load examples/reference/examples.json — ' +
      'run `npm run examples:generate`.';
    return;
  }

  state.data = data;
  state.conventions = conventions;
  const broken = conventions ? conventions.conventions.filter(c => !c.holds).length : 0;
  const intended = data.cases.filter(c => !c.pair && caseIsIndeterminate(c)).length;
  const tone = data.cases.every(c => c.pair || !caseIsIndeterminate(c) || intended) ? 'good' : 'warn';
  setChip('libraryChip', data.cases.length + ' cases · kernel v' +
    (data.kernelLossStages === 1 ? '3' : '?') + ' · ' + broken + ' broken v2 conventions', tone);

  renderPairs(data.cases);
  populatePresets();
  renderTable();
  renderPlots();

  // main.js sets window.__tautString synchronously during boot, which runs
  // before this async loader resolves.
  state.filter = $('libraryFilter').value;
  window.__tautString.library = {
    data,
    conventions,
    visible: () => visibleCases().map(c => c.id),
    filter: (value) => {
      state.filter = value;
      renderTable();
      renderPlots();
    },
    runComparison,
    getMaintenance: () => state.maintenance
  };

  // The "conventions" have to be visible somewhere: put them under the pairs
  // rather than only in the JSON file.
  renderConventions();

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const draw of state.plots) draw();
    }, 120);
  });

  // <details> content has zero width while closed, so canvases are first
  // painted when the user opens the section.
  const plotHost = $('libraryPlotHost');
  if (plotHost) {
    plotHost.addEventListener('toggle', () => {
      if (plotHost.open) for (const draw of state.plots) draw();
    });
  }
}
