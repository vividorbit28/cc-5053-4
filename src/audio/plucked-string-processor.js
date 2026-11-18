/*
 * AudioWorkletProcessor wrapper around StringModel.
 *
 * The DSP lives in ../core/string-model.js and is imported as an ES module,
 * so the realtime worklet and the offline renderer run the same arithmetic.
 *
 * main → worklet
 *   { type:'configure', params:{lengthMeters?, frequency?, t60, damping, pluckPosition?, pickupPosition?} }
 *   { type:'pluck', amplitude, pluckPosition }
 *   { type:'burst', amplitude, durationMs, pluckPosition }
 *   { type:'release' } | { type:'reset' } | { type:'telemetry', enabled } | { type:'master', value }
 *
 * worklet → main
 *   ready / state / telemetry / error / fault / excitation / reset
 */

import {
  StringModel,
  ModelError,
  predictedT60ForFrequency,
  frequencyForStringLength,
  stringLengthForFrequency,
} from '../core/string-model.js';

const SCOPE_SIZE = 1024;

class PluckedStringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.model = new StringModel(sampleRate);
    this.enabled = true;
    this.master = 0.6;
    this.requested = { frequency: 220, t60: 3, damping: null, pluckPosition: 0.18, pickupPosition: 0.52 };
    this.faulted = false;
    this.telemetryEnabled = true;
    this.blockCount = 0;
    this.telemetryEvery = Math.max(1, Math.round(sampleRate / (128 * 20)));
    this.scope = new Float32Array(SCOPE_SIZE);
    this.scopeWrite = 0;
    this.scopeStride = 1;
    this.scopeCounter = 0;
    this.envValue = 0;
    this.envHistory = new Float32Array(256);
    this.envWrite = 0;
    this.capture = null;
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.postMessage({ type: 'ready', sampleRate });
    this.reconfigure(this.requested, true);
  }

  reconfigure(params, initial = false) {
    try {
      const next = { ...this.requested, ...params };
      if (params.lengthMeters !== undefined) {
        next.frequency = frequencyForStringLength(params.lengthMeters);
      }
      if (params.damping !== undefined) {
        next.damping = params.damping === null ? null : params.damping;
      }
      const lossLambda = next.damping === null ? undefined : next.damping;
      const applied = this.model.configure({
        frequency: next.frequency,
        t60: next.t60,
        lossLambda,
        pluckPosition: next.pluckPosition,
        pickupPosition: next.pickupPosition
      });
      this.requested = next;
      this.faulted = false;
      this.postState(applied);
    } catch (err) {
      this.postError(err);
      if (initial) {
        // A failure during construction must be visible, not silent.
        this.port.postMessage({ type: 'fault', data: { message: String(err.message || err), fatal: true } });
      }
    }
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'configure':
        this.reconfigure(msg.params || {});
        break;
      case 'pluck':
        this.excite('pluck', msg);
        break;
      case 'burst':
        this.excite('burst', msg);
        break;
      case 'release':
        this.enabled = false;
        break;
      case 'reset':
        this.model.reset();
        this.faulted = false;
        this.enabled = true;
        this.port.postMessage({ type: 'reset' });
        this.postState();
        break;
      case 'telemetry':
        this.telemetryEnabled = !!msg.enabled;
        break;
      case 'master':
        this.master = Math.min(1.5, Math.max(0, Number(msg.value) || 0));
        break;
      case 'capture':
        if (msg.enabled) {
          const seconds = Math.min(10, Math.max(0.2, Number(msg.seconds) || 2));
          this.capture = {
            remaining: Math.round(seconds * sampleRate),
            chunkSize: Math.max(1024, Number(msg.chunk) || 8192),
            pending: []
          };
        } else {
          this.capture = null;
        }
        break;
      default:
        break;
    }
  }

  excite(kind, msg) {
    try {
      if (this.faulted) throw new ModelError('Model is faulted; press Reset before playing');
      if (kind === 'burst') {
        this.model.burst(msg.amplitude ?? 0.45, msg.durationMs ?? 2.5, msg.pluckPosition);
      } else {
        this.model.pluck(msg.amplitude ?? 0.6, msg.pluckPosition);
      }
      this.enabled = true;
      this.envValue = msg.amplitude ?? 0.6;
      this.port.postMessage({ type: 'excitation', kind, amplitude: msg.amplitude });
    } catch (err) {
      this.postError(err);
    }
  }

  postError(err) {
    this.port.postMessage({
      type: 'error',
      message: err instanceof ModelError ? err.message : String((err && err.message) || err),
      detail: err && err.detail ? err.detail : null
    });
  }

  postState(applied) {
    const snap = this.model.snapshot();
    this.port.postMessage({
      type: 'state',
      data: {
        ...snap,
        ...(applied ? {
          appliedFrequency: applied.frequency,
          appliedGain: applied.gain,
          gainLimited: applied.gainLimited,
          integerDelay: applied.integerDelay,
          allpass: applied.allpass,
          allpassDelay: applied.allpassDelay,
          lossLambda: applied.lossLambda,
          lossPhase: applied.lossPhase,
          targetDelay: applied.targetDelay,
          totalDelay: applied.totalDelay,
          tuningErrorCents: applied.tuningErrorCents
        } : {}),
        requested: { ...this.requested },
        stringLength: stringLengthForFrequency(this.requested.frequency)
      }
    });
  }

  /*
   * Ship the post-limiter output (not the raw loop) to the UI in blocks, so
   * the on-screen analysis runs on what was actually produced.
   */
  captureBlock(channel) {
    const cap = this.capture;
    const take = Math.min(cap.remaining, channel.length);
    const copy = new Float32Array(take);
    copy.set(channel.subarray(0, take));
    cap.pending.push(copy);
    cap.remaining -= take;
    if (cap.remaining <= 0) {
      this.port.postMessage({ type: 'capture', chunks: cap.pending, complete: true });
      this.capture = null;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    if (!this.enabled) {
      channel.fill(0);
      return true;
    }
    const stride = Math.max(1, Math.floor(channel.length / 128));
    for (let i = 0; i < channel.length; i++) {
      const sample = this.model.tick();
      const scaled = sample * this.master;
      // Output limit only (loop stability comes from g < 1).  Clipped samples
      // are counted so the UI can show "output clipping", which is distinct
      // from an internal fault.
      if (scaled > 1 || scaled < -1) this.clipCount = (this.clipCount || 0) + 1;
      channel[i] = scaled > 1 ? 1 : scaled < -1 ? -1 : scaled;
      this.envValue += 0.0002 * (Math.abs(sample) - this.envValue);
      if (i % stride === 0) {
        this.scope[this.scopeWrite] = sample;
        this.scopeWrite = (this.scopeWrite + 1) % SCOPE_SIZE;
      }
    }
    if (this.model.diverged && !this.faulted) {
      this.faulted = true;
      this.port.postMessage({ type: 'fault', data: this.model.snapshot() });
    }
    if (this.capture) this.captureBlock(channel);
    this.blockCount++;
    if (this.telemetryEnabled && this.blockCount >= this.telemetryEvery) {
      this.blockCount = 0;
      this.envHistory[this.envWrite] = Math.sqrt(this.model.rms * 2);
      this.envWrite = (this.envWrite + 1) % this.envHistory.length;
      this.port.postMessage({
        type: 'telemetry',
        data: {
          time: currentTime,
          state: this.model.state,
          peak: this.model.peak,
          rms: Math.sqrt(this.model.rms * 2),
          loopPeak: this.model.loopPeak,
          trips: this.model.trips,
          gain: this.model.gain,
          diverged: this.model.diverged,
          clipCount: this.clipCount || 0,
          observe: { ...this.model.observe },
          scope: Array.from(this.scope),
          scopeStart: this.scopeWrite,
          // RMS displacement over one period: the standing-wave envelope,
          // computed live from the loop (not an animation).
          profile: Array.from(this.model.line.displacementEnvelope(160)),
          linePeak: this.model.loopPeak
        }
      });
    }
    return true;
  }
}

registerProcessor('plucked-string', PluckedStringProcessor);
