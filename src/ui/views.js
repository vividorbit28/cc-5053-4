/*
 * Canvas visualisations.  Each renderer is independent and repaints only
 * when its inputs change; the string canvas runs a continuous idle loop only
 * while the string is visibly moving.
 */

const DPR = () => Math.min(2, window.devicePixelRatio || 1);

function fitCanvas(canvas) {
  const dpr = DPR();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function line(ctx, points, color, width = 1.5, dash = null) {
  if (points.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  ctx.restore();
}

/* ───────────────────────────── string ───────────────────────────────── */

export class StringView {
  constructor(canvas, onPluck) {
    this.canvas = canvas;
    this.onPluck = onPluck;
    this.pluckFraction = 0.18;
    this.pickupFraction = 0.52;
    this.drag = null;
    this.profile = null;      // displacement profile from telemetry
    this.level = 0;
    this.bind();
  }

  setPositions(pluck, pickup) {
    this.pluckFraction = pluck;
    this.pickupFraction = pickup;
    this.draw();
  }

  // `profile` is the string's displacement at this instant (two-tap pickup
  // reconstruction).  Its peak defines the visible amplitude, so the drawing
  // shrinks as the tone decays.
  setProfile(profile) {
    this.profile = profile;
    let max = 0;
    for (let i = 0; i < profile.length; i++) max = Math.max(max, Math.abs(profile[i]));
    this.level = max;
    this.draw();
  }

  bind() {
    const c = this.canvas;
    const fracFromEvent = (event) => {
      const rect = c.getBoundingClientRect();
      return Math.min(0.97, Math.max(0.03, (event.clientX - rect.left) / rect.width));
    };
    c.addEventListener('pointerdown', (event) => {
      c.setPointerCapture(event.pointerId);
      c.classList.add('dragging');
      const frac = fracFromEvent(event);
      this.drag = { frac, depth: 0 };
      this.setPositions(frac, this.pickupFraction);
      event.preventDefault();
    });
    c.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const rect = c.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const depth = Math.min(1, Math.max(0, (y - this.anchorY) / this.maxDepth));
      this.drag.depth = depth;
      this.drag.frac = fracFromEvent(event);
      this.draw();
      event.preventDefault();
    });
    const finish = (event) => {
      if (!this.drag) return;
      const { frac, depth } = this.drag;
      this.drag = null;
      c.classList.remove('dragging');
      if (depth > 0.03 && this.onPluck) this.onPluck({ position: frac, depth });
      this.draw();
      if (event) event.preventDefault();
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
    c.addEventListener('pointerleave', (event) => { if (this.drag) finish(event); });
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    const padX = 26;
    const anchorY = height * 0.42;
    this.anchorY = anchorY;
    this.maxDepth = height * 0.44;
    const x0 = padX;
    const x1 = width - padX;
    const span = x1 - x0;
    const y = anchorY;

    // Bridge / nut posts
    ctx.fillStyle = '#2a333d';
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.roundRect(x - 3, y - 16, 6, 32, 3);
      ctx.fill();
    }
    ctx.fillStyle = '#1d242c';
    ctx.fillRect(x0, y + 4, span, 2);

    // Position markers
    const marker = (frac, label, color) => {
      const x = x0 + frac * span;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, y - height * 0.36);
      ctx.lineTo(x, y + 14);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - height * 0.36 - 6);
      ctx.globalAlpha = 1;
      // pickup triangle
      ctx.beginPath();
      ctx.moveTo(x - 5, y + 18);
      ctx.lineTo(x + 5, y + 18);
      ctx.lineTo(x, y + 26);
      ctx.closePath();
      ctx.fill();
    };
    marker(this.pluckFraction, 'pluck', '#e4b45f');
    marker(this.pickupFraction, 'pickup', '#7aa7ff');

    // String shape: the drag preview takes priority; otherwise draw the
    // string's actual displacement profile at this instant.
    const pluckX = x0 + this.pluckFraction * span;
    const dragDepth = this.drag ? this.drag.depth : 0;
    const dragX = this.drag ? x0 + this.drag.frac * span : pluckX;
    const points = [];
    if (dragDepth > 0.001) {
      const segments = 220;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const x = x0 + t * span;
        const peakT = (dragX - x0) / span;
        const tri = t <= peakT
          ? (peakT > 0 ? t / peakT : 0)
          : ((1 - t) / (1 - peakT));
        points.push([x, y + dragDepth * this.maxDepth * tri]);
      }
    } else if (this.profile && this.profile.length > 2 && this.level > 1e-7) {
      // Standing-wave envelope (RMS displacement over one period), read from
      // the delay line.  Pinned at both ends; the read-out shows the level.
      const scale = Math.min(1, Math.sqrt(this.level) * 2.6);
      for (let i = 0; i < this.profile.length; i++) {
        const t = i / (this.profile.length - 1);
        const v = this.profile[i] / this.level;
        points.push([x0 + t * span, y - v * this.maxDepth * 0.75 * scale]);
      }
    } else {
      points.push([x0, y], [x1, y]);
    }

    // Glow
    ctx.save();
    ctx.strokeStyle = 'rgba(228, 180, 95, 0.30)';
    ctx.lineWidth = 7;
    ctx.filter = 'blur(6px)';
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const p of points) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.restore();

    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, '#9a8256');
    grad.addColorStop(0.5, '#f0cd8a');
    grad.addColorStop(1, '#9a8256');
    line(ctx, points, grad, 2.2);

    // Motion read-out, from the real displacement amplitude.
    if (this.profile && this.level > 1e-7) {
      ctx.fillStyle = 'rgba(232, 236, 241, 0.55)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('displacement ' + this.level.toFixed(4), x0, height - 10);
    }
  }
}

/* ───────────────────────────── decay ────────────────────────────────── */

export class DecayView {
  constructor(canvas) {
    this.canvas = canvas;
    this.history = [];      // {t, db}
    this.t60 = 0;
    this.duration = 4;
    this.peak = 0;
    this.origin = 0;
  }

  reset() {
    this.history = [];
    this.peak = 0;
    this.origin = 0;
    this.draw();
  }

  // Telemetry-driven envelope, integrated from the model's output RMS.
  pushLevel(time, level) {
    if (!(level >= 0)) return;
    if (this.origin === 0) this.origin = time;
    this.peak = Math.max(this.peak * 0.9995, level);
    if (this.peak < 1e-9) return;
    const db = Math.max(-90, 20 * Math.log10(level / this.peak + 1e-12));
    const last = this.history[this.history.length - 1];
    if (!last || time > last.t) this.history.push({ t: time - this.origin, db });
    while (this.history.length > 1 && this.history[0].t < this.history[this.history.length - 1].t - this.duration - 1) {
      this.history.shift();
    }
    this.draw();
  }

  setPrediction(t60) {
    this.t60 = t60;
    this.draw();
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    const padL = 34;
    const padR = 10;
    const padT = 10;
    const padB = 20;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const dbMin = -70;
    const dbMax = 0;

    // Grid
    ctx.strokeStyle = '#1c232b';
    ctx.fillStyle = '#5b6673';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let db = 0; db >= dbMin; db -= 20) {
      const y = padT + (dbMax - db) / (dbMax - dbMin) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(db + '', padL - 7, y + 3);
    }
    const now = this.history.length ? this.history[this.history.length - 1].t : 0;
    const tStart = Math.max(0, now - this.duration);
    const tEnd = tStart + this.duration;
    for (let i = 0; i <= 4; i++) {
      const t = tStart + (tEnd - tStart) * i / 4;
      const x = padL + (t - tStart) / (tEnd - tStart) * plotW;
      ctx.strokeStyle = '#151b21';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#5b6673';
      ctx.textAlign = 'center';
      ctx.fillText(t.toFixed(1) + 's', x, height - 6);
    }

    // Predicted T60 guide: a 60 dB fall over T60 seconds, aligned to now.
    if (this.t60 > 0.05 && this.history.length) {
      const x0 = padL + (now - tStart) / (tEnd - tStart) * plotW;
      const x1 = padL + (Math.min(tEnd, now + this.t60) - tStart) / (tEnd - tStart) * plotW;
      const y0 = padT + 6;
      const y1 = padT + (dbMax - dbMin) / (dbMax - dbMin) * plotH;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(232, 178, 74, 0.4)';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(232, 178, 74, 0.65)';
      ctx.textAlign = 'right';
      ctx.fillText('T60 ' + this.t60.toFixed(2) + 's', width - padR, padT + 12);
    }

    // Live envelope
    const pts = this.history.map(({ t, db }) => {
      const x = padL + (t - tStart) / (tEnd - tStart) * plotW;
      const y = padT + (dbMax - Math.max(dbMin, db)) / (dbMax - dbMin) * plotH;
      return [x, y];
    });
    if (pts.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], padT + plotH);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.lineTo(pts[pts.length - 1][0], padT + plotH);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      fill.addColorStop(0, 'rgba(228, 180, 95, 0.28)');
      fill.addColorStop(1, 'rgba(228, 180, 95, 0.02)');
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
      line(ctx, pts, '#e4b45f', 1.8);
    }

    if (!pts.length) {
      ctx.fillStyle = '#4a5561';
      ctx.textAlign = 'center';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('pluck to record a decay', padL + plotW / 2, padT + plotH / 2);
    }
  }
}

/* ───────────────────────────── partials ─────────────────────────────── */

export class PartialView {
  constructor(canvas) {
    this.canvas = canvas;
    this.measured = [];
    this.predicted = [];
  }

  set(measured, predicted) {
    this.measured = measured;
    this.predicted = predicted;
    this.draw();
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    const padL = 6;
    const padR = 6;
    const padT = 8;
    const padB = 16;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const count = Math.max(this.measured.length, this.predicted.length, 1);
    const slot = plotW / count;
    const barW = Math.min(24, slot * 0.34);
    const all = [...this.measured, ...this.predicted].filter(Number.isFinite);
    const maxValue = Math.max(0.001, ...all, 0.001);

    ctx.strokeStyle = '#1c232b';
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    ctx.lineTo(width - padR, padT + plotH);
    ctx.stroke();

    for (let i = 0; i < count; i++) {
      const x = padL + slot * (i + 0.5);
      const m = Number.isFinite(this.measured[i]) ? this.measured[i] : 0;
      const p = Number.isFinite(this.predicted[i]) ? this.predicted[i] : 0;
      const mh = Math.max(0, m / maxValue) * plotH;
      const ph = Math.max(0, p / maxValue) * plotH;
      ctx.fillStyle = 'rgba(228, 180, 95, 0.85)';
      ctx.fillRect(x - barW - 1, padT + plotH - mh, barW, mh);
      ctx.strokeStyle = 'rgba(122, 167, 255, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + 1 - 0.5, padT + plotH - ph - 0.5, barW, Math.max(ph, 0.5));
      ctx.fillStyle = '#5b6673';
      ctx.font = '9.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, height - 4);
    }
    if (!all.length) {
      ctx.fillStyle = '#4a5561';
      ctx.textAlign = 'center';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('waiting for telemetry', padL + plotW / 2, padT + plotH / 2);
    }
  }
}

/* ───────────────────────── waveguide scope ──────────────────────────── */

export class ScopeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.snapshot = null;
    this.history = [];
  }

  push(observe, time) {
    this.snapshot = observe;
    this.history.push({ t: time, ...observe });
    if (this.history.length > 220) this.history.shift();
    this.draw();
  }

  draw() {
    const { ctx, width, height } = fitCanvas(this.canvas);
    const padT = 8;
    const padB = 8;
    const plotH = height - padT - padB;

    ctx.strokeStyle = '#151b21';
    ctx.beginPath();
    ctx.moveTo(0, padT + plotH / 2);
    ctx.lineTo(width, padT + plotH / 2);
    ctx.stroke();

    if (this.history.length < 2) {
      ctx.fillStyle = '#4a5561';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('stage values stream while playing', width / 2, padT + plotH / 2 - 6);
      return;
    }
    const keys = [
      { key: 'delayed', color: '#7aa7ff' },
      { key: 'allpassOut', color: '#b28bff' },
      { key: 'loss2', color: '#e4b45f' },
      { key: 'write', color: '#6fd3a1' },
      { key: 'out', color: '#e8736b' }
    ];
    let peak = 1e-6;
    for (const sample of this.history) {
      for (const { key } of keys) peak = Math.max(peak, Math.abs(sample[key] || 0));
    }
    const n = this.history.length;
    for (const { key, color } of keys) {
      const pts = this.history.map((sample, i) => {
        const x = (i / (n - 1)) * width;
        const y = padT + plotH / 2 - (sample[key] / peak) * (plotH / 2 - 3);
        return [x, y];
      });
      line(ctx, pts, color, 1.25);
    }
  }
}
