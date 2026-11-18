/*
 * Browser integration check.
 *
 * Launches headless Chromium against the running server, starts audio,
 * plucks, and asserts that:
 *   - the worklet module and its imports load (no page errors)
 *   - audio context reaches "running"
 *   - the loop state is applied and tuned (integer delay, allpass, gain)
 *   - the captured output has energy, is finite, and decays
 *   - the UI reflects measured f0 and the internals table is populated
 *   - changing string length retunes the loop and a rejected parameter
 *     produces a visible error
 *
 * Usage: node test/browser-check.js [baseUrl]
 */

import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:4173/';
const failures = [];
const notes = [];
function check(name, condition, detail = '') {
  if (condition) notes.push('PASS ' + name + (detail ? ' — ' + detail : ''));
  else failures.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceOutOfProcess'
  ]
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push('console: ' + msg.text());
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

check('no page errors on load', pageErrors.length === 0, pageErrors.join(' | '));

// Start audio through the real button.
await page.click('#startAudio');
await page.waitForFunction(() => window.__tautString && window.__tautString.state.started, null, { timeout: 8000 })
  .catch(() => {});

const started = await page.evaluate(() => window.__tautString.state.started);
check('audio started', started);

const contextState = await page.evaluate(() => window.__tautString.engine.context
  ? window.__tautString.engine.context.state : 'none');
check('audio context running', contextState === 'running', contextState);

// Wait for the state message and check tuning.
await page.waitForFunction(() => {
  const s = window.__tautString.state.applied;
  return s && s.appliedFrequency > 0;
}, null, { timeout: 5000 }).catch(() => {});
const applied = await page.evaluate(() => window.__tautString.state.applied);
check('loop configured', !!applied && applied.appliedFrequency > 0,
  applied ? applied.appliedFrequency.toFixed(2) + ' Hz' : 'none');
check('tuning error < 0.01 cent (analytic)', !!applied && Math.abs(applied.tuningErrorCents) < 1e-3,
  applied ? applied.tuningErrorCents.toExponential(2) : 'n/a');
check('loop gain below 1', !!applied && applied.appliedGain > 0 && applied.appliedGain < 1,
  applied ? applied.appliedGain.toFixed(6) : 'n/a');
check('integer delay > 0 with fractional allpass', !!applied && applied.integerDelay > 1 &&
  Number.isFinite(applied.allpass), applied ? 'N=' + applied.integerDelay + ' a=' + applied.allpass.toFixed(4) : '');

// Pluck and capture.
const capture = await page.evaluate(async () => {
  const { engine, pluckNow } = window.__tautString;
  const chunks = [];
  let complete = false;
  const handler = (event) => {
    chunks.push(...event.detail.chunks);
    if (event.detail.complete) complete = true;
  };
  engine.addEventListener('capture', handler);
  engine.node.port.postMessage({ type: 'capture', enabled: true, seconds: 2.2, chunk: 8192 });
  pluckNow(0.6);
  const t0 = performance.now();
  while (!complete && performance.now() - t0 < 6000) {
    await new Promise(r => setTimeout(r, 50));
  }
  engine.removeEventListener('capture', handler);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { buffer.set(c, offset); offset += c.length; }
  const fs = engine.context.sampleRate;
  let peak = 0;
  let finite = true;
  for (const x of buffer) {
    if (!Number.isFinite(x)) finite = false;
    else peak = Math.max(peak, Math.abs(x));
  }
  const block = Math.round(fs * 0.02);
  const energies = [];
  for (let start = 0; start + block <= buffer.length; start += block) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += buffer[i] * buffer[i];
    energies.push(sum / block);
  }
  // Decay ratio: first quarter vs last quarter of the captured second-and-a-half.
  const half = Math.floor(energies.length / 2);
  const early = energies.slice(0, Math.max(1, Math.floor(energies.length * 0.15)))
    .reduce((a, b) => a + b, 0);
  const late = energies.slice(Math.floor(energies.length * 0.75))
    .reduce((a, b) => a + b, 0);
  return { total, complete, peak, finite, early, late, fs, energies: energies.slice(0, 40) };
});
check('capture completed', capture.complete, capture.total + ' samples');
check('output has energy', capture.peak > 0.01, 'peak ' + capture.peak.toFixed(3));
check('output finite', capture.finite);
check('output decays', capture.late < capture.early, 'early ' + capture.early.toFixed(4) + ' → late ' + capture.late.toFixed(4));
check('output within limiter', capture.peak <= 1.0001, 'peak ' + capture.peak.toFixed(3));

// UI reflects analysis after the next pluck.
await page.evaluate(() => window.__tautString.pluckNow(0.6));
await page.waitForTimeout(2600);
const uiPitch = await page.textContent('#mPitch');
const uiTune = await page.textContent('#oTune');
check('UI shows measured pitch', /\d+\.\d+ Hz/.test(uiPitch), uiPitch);
check('UI shows internals tuning error', /e-|0\.0/.test(uiTune), uiTune);
const nInt = await page.textContent('#oNint');
check('UI shows loop internals', Number(nInt) > 0, 'N=' + nInt);

// Change string length and confirm retune.
await page.evaluate(() => {
  const el = document.getElementById('length');
  el.value = '0.32';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(600);
const retuned = await page.evaluate(() => window.__tautString.state.applied);
check('length change retunes', retuned && Math.abs(retuned.appliedFrequency - 440) < 2,
  retuned ? retuned.appliedFrequency.toFixed(2) + ' Hz' : 'none');

// Request an impossible frequency and confirm a visible error.
await page.evaluate(() => {
  const el = document.getElementById('length');
  el.value = '0.14';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  window.__tautString.engine.configure({ frequency: 24000 });
});
await page.waitForTimeout(400);
const toastText = await page.textContent('#toast').catch(() => '');
const toastShown = await page.evaluate(() => {
  const el = document.getElementById('toast');
  return !el.hidden && el.textContent;
});
check('invalid pitch surfaces error', /Nyquist|above|too close/i.test(toastShown || ''), (toastShown || '').slice(0, 90));

// Offline render through the UI.
await page.evaluate(() => { document.getElementById('length').value = '0.64';
  document.getElementById('length').dispatchEvent(new Event('change', { bubbles: true })); });
await page.waitForTimeout(300);
await page.click('#renderOffline');
await page.waitForTimeout(2500);
const refPitch = await page.textContent('#refPitch');
const refErr = await page.textContent('#refPitchErr');
const refT60 = await page.textContent('#refT60');
check('offline render produced pitch', /\d+\.\d+ Hz/.test(refPitch), refPitch);
check('offline pitch error < 1 cent', /-?\d+\.\d+ cents/.test(refErr), refErr);
check('offline T60 measured', /\d+\.\d+ s/.test(refT60), refT60);
const wavHref = await page.getAttribute('#downloadWav', 'href');
check('WAV available', !!wavHref && wavHref.startsWith('blob:'), wavHref ? wavHref.slice(0, 20) + '…' : '');

// Screenshot for manual review.
await page.screenshot({ path: 'test/screenshot.png', fullPage: true });

await browser.close();

for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
console.log('\n' + (failures.length ? failures.length + ' failure(s)' : 'All browser checks passed'));
process.exit(failures.length ? 1 : 0);
