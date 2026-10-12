// Five-graph incremental ONNX pipeline. No Moonshine WASM runtime is needed.
import * as ort from 'onnxruntime-web/webgpu';
import { Tokenizer } from '@huggingface/tokenizers';
import { reviseWords } from './moonshine-words.js';

const SAMPLE_RATE = 16000, BLOCK = 640, UPDATE = 12800, MAX_SEGMENT = 12 * SAMPLE_RATE;
const append = (a, b) => { const out = new Float32Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const float = (data, dims) => new ort.Tensor('float32', data, dims);
const integer = value => new ort.Tensor('int64', BigInt64Array.of(BigInt(value)), [1]);
const dispose = values => { for (const tensor of new Set(Object.values(values || {}))) tensor.dispose(); };

export class MoonshineBrowserASR {
  sessions = {};
  words = [];
  async load(status, { readModel, device }) {
    if (device !== 'wasm') throw Error('Moonshine INT8 requires CPU processing');
    const json = async name => JSON.parse(new TextDecoder().decode(await readModel(name)));
    this.config = await json('streaming_config.json');
    this.tokenizer = new Tokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
    try {
      // Sequential loading keeps temporary weight buffers from overlapping.
      for (const name of ['frontend', 'encoder', 'adapter', 'cross_kv', 'decoder_kv']) {
        status(`Loading Moonshine ${name}`);
        this.sessions[name] = await ort.InferenceSession.create(await readModel(name === 'frontend' ? 'frontend.onnx' : `${name}_int8.onnx`), {
          executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false,
        });
      }
    } catch (error) {
      await Promise.all(Object.values(this.sessions).map(session => session.release()));
      this.sessions = {}; throw error;
    }
    this.startStream();
  }
  startStream() {
    this.clearSegment();
    this.words = []; this.completed = 0; this.samples = 0;
    this.pending = new Float32Array(); this.preroll = new Float32Array();
    this.metrics = { featuresMs: 0, encoderMs: 0, decoderMs: 0, encoderCalls: 0, decoderCalls: 0, firstEncoderMs: 0, maxEncoderMs: 0, speechSegments: 0, decoderLimitHits: 0, wordTiming: 'estimated', maxSegmentSeconds: 12 };
  }
  clearSegment() {
    dispose(this.frontendState);
    this.frontendState = null; this.segmentStart = null; this.segmentSamples = 0;
    this.silenceSamples = 0; this.lastSpeech = 0;
    this.toEncode = new Float32Array(); this.features = new Float32Array(); this.featureBase = 0;
    this.emitted = 0; this.memory = new Float32Array();
  }
  begin(start) {
    this.segmentStart = start;
    this.frontendState = Object.fromEntries(Object.entries(this.config.frontend_state_shapes).map(([name, dims]) => [name,
      /sample_len|frame_count/.test(name) ? new ort.Tensor('int64', new BigInt64Array(dims.reduce((a,b)=>a*b,1)), dims)
        : float(new Float32Array(dims.reduce((a,b)=>a*b,1)), dims)]));
  }
  async encode(final) {
    const c = this.config;
    if (this.toEncode.length) {
      const audio = float(this.toEncode, [1, this.toEncode.length]);
      const started = performance.now();
      let out;
      try { out = await this.sessions.frontend.run({ audio_chunk: audio, ...this.frontendState }); }
      finally { audio.dispose(); this.metrics.featuresMs += performance.now() - started; }
      dispose(this.frontendState);
      this.frontendState = Object.fromEntries(Object.keys(c.frontend_state_shapes).map(name => [name, out[`${name}_out`]]));
      this.features = append(this.features, out.features.data); out.features.dispose();
      this.toEncode = new Float32Array();
    }
    const total = this.featureBase + this.features.length / c.encoder_dim;
    const stable = final ? total : Math.max(0, total - c.total_lookahead);
    const count = stable - this.emitted;
    if (count <= 0) return;
    const started = performance.now();
    const input = float(this.features, [1, total - this.featureBase, c.encoder_dim]);
    let encoded, memory, slice, position;
    try {
      encoded = (await this.sessions.encoder.run({ features: input })).encoded;
      const first = (this.emitted - this.featureBase) * c.encoder_dim;
      slice = float(encoded.data.slice(first, first + count * c.encoder_dim), [1, count, c.encoder_dim]);
      position = integer(this.emitted);
      memory = (await this.sessions.adapter.run({ encoded: slice, pos_offset: position })).memory;
      this.memory = append(this.memory, memory.data);
    } finally {
      input.dispose(); encoded?.dispose(); slice?.dispose(); position?.dispose(); memory?.dispose();
      const ms = performance.now() - started;
      this.metrics.encoderMs += ms;
      if (!this.metrics.encoderCalls++) this.metrics.firstEncoderMs = ms;
      this.metrics.maxEncoderMs = Math.max(this.metrics.maxEncoderMs, ms);
    }
    this.emitted = stable;
    const keep = Math.max(0, stable - c.total_left_context);
    this.features = this.features.slice((keep - this.featureBase) * c.encoder_dim); this.featureBase = keep;
  }
  async decode(final) {
    const c = this.config;
    if (!this.emitted) return;
    const started = performance.now();
    const memory = float(this.memory, [1, this.emitted, c.decoder_dim]);
    let cross, k, v;
    const tokens = [];
    try {
      cross = await this.sessions.cross_kv.run({ memory });
      const shape = [c.depth, 1, c.nheads, 0, c.head_dim];
      k = float(new Float32Array(), shape); v = float(new Float32Array(), shape);
      let token = c.bos_id;
      // Regenerate the bounded active phrase against updated encoder memory;
      // cached self-attention is reused within each autoregressive pass.
      const limit = Math.min(256, Math.max(16, Math.ceil(this.segmentSamples / SAMPLE_RATE * 12)));
      for (let i = 0; i < limit; i++) {
        const inputToken = new ort.Tensor('int64', BigInt64Array.of(BigInt(token)), [1, 1]);
        let output;
        try {
          // Fetch only what is needed: avoid copying cross K/V back per token.
          output = await this.sessions.decoder_kv.run({ token: inputToken, k_self: k, v_self: v, out_k_cross: cross.k_cross, out_v_cross: cross.v_cross }, ['logits', 'out_k_self', 'out_v_self']);
        } finally { inputToken.dispose(); }
        this.metrics.decoderCalls++;
        k.dispose(); v.dispose(); k = output.out_k_self; v = output.out_v_self;
        const logits = output.logits.data;
        token = 0;
        for (let j = 1; j < c.vocab_size; j++) if (logits[j] > logits[token]) token = j;
        output.logits.dispose();
        if (token === c.eos_id) break;
        tokens.push(token);
        if (i === limit - 1) this.metrics.decoderLimitHits++;
      }
      // EOS can be the first prediction for silence or an incomplete onset.
      // The tokenizer rejects [], but an empty hypothesis is valid here.
      const text = tokens.length ? this.tokenizer.decode(tokens, { skip_special_tokens: true }).trim() : '';
      const end = this.segmentStart + Math.min(this.lastSpeech, this.emitted * 320) / SAMPLE_RATE;
      const revised = reviseWords(this.words.slice(this.completed), text, this.segmentStart, end, final);
      this.words = [...this.words.slice(0, this.completed), ...revised];
    } finally {
      memory.dispose(); dispose(cross); k?.dispose(); v?.dispose();
      this.metrics.decoderMs += performance.now() - started;
    }
  }
  async update(final, publish) {
    if (this.segmentStart === null) return;
    await this.encode(final); await this.decode(final);
    if (final) { this.completed = this.words.length; this.metrics.speechSegments++; this.clearSegment(); }
    publish?.();
  }
  async pushAudio(samples, flush, publish) {
    this.pending = append(this.pending, samples);
    let chunks = 0, offset = 0;
    while (offset + BLOCK <= this.pending.length || (flush && offset < this.pending.length)) {
      const valid = Math.min(BLOCK, this.pending.length - offset);
      const block = new Float32Array(BLOCK); block.set(this.pending.subarray(offset, offset + valid)); offset += valid;
      let energy = 0; for (const value of block) energy += value * value;
      const voiced = Math.sqrt(energy / valid) > .003;
      if (this.segmentStart === null) {
        if (!voiced) { this.preroll = append(this.preroll, block).slice(-3200); this.samples += valid; continue; }
        this.begin((this.samples - this.preroll.length) / SAMPLE_RATE);
        this.toEncode = this.preroll; this.segmentSamples = this.preroll.length; this.preroll = new Float32Array();
      }
      this.toEncode = append(this.toEncode, block); this.segmentSamples += BLOCK; this.samples += valid;
      if (voiced) { this.silenceSamples = 0; this.lastSpeech = this.segmentSamples; }
      else this.silenceSamples += BLOCK;
      const final = this.silenceSamples >= 9600 || this.segmentSamples >= MAX_SEGMENT;
      if (final || this.toEncode.length >= UPDATE) { await this.update(final, publish); chunks++; }
    }
    this.pending = this.pending.slice(offset);
    if (flush && this.segmentStart !== null) { await this.update(true, publish); chunks++; }
    return { chunks };
  }
}
