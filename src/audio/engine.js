/*
 * Audio engine: owns AudioContext, the worklet node, and the message channel.
 *
 * The worklet is the only source of sound.  Commands flow one way
 * (UI → engine → worklet); state/telemetry/errors flow back (worklet →
 * engine → UI), so a rejected parameter change surfaces as an error in the
 * panel rather than silently leaving the model in a different state.
 */

import { ModelError, frequencyForStringLength, stringLengthForFrequency } from '../core/string-model.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.node = null;
    this.started = false;
    this.telemetry = null;
    this.lastState = null;
    this.lastError = null;
    this.master = 0.6;
    this.analyser = null;
  }

  async start() {
    if (this.started) return this.state();
    this.context = new AudioContext({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended') await this.context.resume();
    await this.context.audioWorklet.addModule(
      new URL('./plucked-string-processor.js', import.meta.url).href
    );
    this.node = new AudioWorkletNode(this.context, 'plucked-string', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {}
    });
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    this.node.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.node.port.onmessage = (event) => this.handleMessage(event.data);
    this.node.port.postMessage({ type: 'master', value: this.master });
    this.started = true;
    this.emit('started', this.state());
    return this.state();
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.emit('ready', { sampleRate: msg.sampleRate, contextRate: this.context.sampleRate });
        break;
      case 'state':
        this.lastState = msg.data;
        this.emit('state', msg.data);
        break;
      case 'telemetry':
        this.telemetry = msg.data;
        this.emit('telemetry', msg.data);
        break;
      case 'error':
        this.lastError = msg;
        this.emit('model-error', msg);
        break;
      case 'fault':
        this.emit('fault', msg.data);
        break;
      case 'excitation':
        this.emit('excitation', msg.kind);
        break;
      case 'capture':
        this.emit('capture', msg);
        break;
      case 'reset':
        this.emit('reset', null);
        break;
      default:
        break;
    }
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  requireStarted() {
    if (!this.started) {
      throw new ModelError('Press “Start audio” before playing', { kind: 'audio-not-started' });
    }
  }

  configure({ lengthMeters, frequency, t60, damping, pluckPosition, pickupPosition }) {
    this.requireStarted();
    const params = { t60, damping, pluckPosition, pickupPosition };
    if (lengthMeters !== undefined) params.lengthMeters = lengthMeters;
    if (frequency !== undefined) params.frequency = frequency;
    this.node.port.postMessage({ type: 'configure', params });
    this.emit('config-sent', params);
  }

  pluck(amplitude, pluckPosition) {
    this.requireStarted();
    this.node.port.postMessage({ type: 'pluck', amplitude, pluckPosition });
  }

  burst(amplitude, durationMs, pluckPosition) {
    this.requireStarted();
    this.node.port.postMessage({ type: 'burst', amplitude, durationMs, pluckPosition });
  }

  release() {
    if (this.node) this.node.port.postMessage({ type: 'release' });
  }

  reset() {
    if (this.node) this.node.port.postMessage({ type: 'reset' });
  }

  setMaster(value) {
    this.master = value;
    if (this.node) this.node.port.postMessage({ type: 'master', value });
  }

  state() {
    return {
      started: this.started,
      sampleRate: this.context ? this.context.sampleRate : 0,
      state: this.context ? this.context.state : 'closed',
      lastState: this.lastState
    };
  }
}

export { frequencyForStringLength, stringLengthForFrequency };
