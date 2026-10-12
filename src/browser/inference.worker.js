import { createOperatorProfile } from './operator-profile.js';
import * as ort from 'onnxruntime-web/webgpu';
import { env } from '../../vendor/transformers/src/env.js';
import { Nemotron3DiarizationProcessor } from '../../vendor/transformers/src/models/nemotron3_diarization/processing_nemotron3_diarization.js';
import { Nemotron3DiarizationForAudioFrameClassification } from '../../vendor/transformers/src/models/nemotron3_diarization/modeling_nemotron3_diarization.js';
import { MODEL_CLASS_TO_NAME_MAPPING, MODEL_NAME_TO_CLASS_MAPPING, MODEL_TYPE_MAPPING, MODEL_TYPES } from '../../vendor/transformers/src/models/modeling_utils.js';
import { readModelBuffer } from './model-buffer';
import { NemotronBrowserASR } from './nemotron';
import { MoonshineBrowserASR } from './moonshine-streaming.js';
import { wordChangeStart } from './moonshine-words.js';
import { CaptionUpdates, processCaptionBatch } from './caption-updates';

// Direct imports bypass Transformers' full model registry. Register just the
// class we use, with the same EncoderOnly type as the upstream registry.
const diarizationClassName = 'Nemotron3DiarizationForAudioFrameClassification';
MODEL_CLASS_TO_NAME_MAPPING.set(Nemotron3DiarizationForAudioFrameClassification, diarizationClassName);
MODEL_NAME_TO_CLASS_MAPPING.set(diarizationClassName, Nemotron3DiarizationForAudioFrameClassification);
MODEL_TYPE_MAPPING.set(diarizationClassName, MODEL_TYPES.EncoderOnly);

// Defence in depth: CSP also confines all network requests to this static origin.
let modelFiles = {};
let assetBase;
const localFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input, self.location.href);
  const method = options?.method || (input instanceof Request ? input.method : 'GET');
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(method)) throw Error('Only local asset reads are allowed');
  if (url.pathname.startsWith('/models/')) {
    const file = modelFiles[decodeURIComponent(url.pathname.slice('/models/'.length))];
    return Promise.resolve(file ? new Response(method === 'HEAD' ? null : file, { headers: { 'Content-Length': String(file.size) } }) : new Response(null, { status:404 }));
  }
  if (!assetBase || !url.href.startsWith(new URL('ort/', assetBase).href)) throw Error('Unexpected asset request');
  return localFetch(input, { ...options, redirect: 'error' });
};
env.fetch = globalThis.fetch;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.useFSCache = false;
let asr, model, processor, cache = null, pcm = new Float32Array(), base = 0, cursor = 0;
let role = 'both', lastWords = [], threads = 1;
let speakerMetrics = { speakerFeaturesMs: 0, speakerMs: 0, speakerCalls: 0, speakerInferenceMs: 0, speakerCacheMs: 0, speakerTensorMs: 0 };
let compareSpeakerOutputs = false;
let loadMs = 0, speakerProfiling = false, operatorProfile, restoreProfileConsole, speakerRuntimeOptions;
const metrics = () => ({ ...asr?.metrics, ...speakerMetrics });
let updates = new CaptionUpdates(), totalSamples = 0, elapsedMs = 0, active = false;
const send = (type, value = {}) => postMessage({ type, ...value });
const status = message => send('status', { message });
function reset() {
  speakerMetrics = { speakerFeaturesMs: 0, speakerMs: 0, speakerCalls: 0, speakerInferenceMs: 0, speakerCacheMs: 0, speakerTensorMs: 0 };
  if (compareSpeakerOutputs) { speakerMetrics.speakerOutputHash = 2166136261; speakerMetrics.speakerOutputValues = 0; }
  cache = null; pcm = new Float32Array(); base = cursor = totalSamples = elapsedMs = 0;
  updates = new CaptionUpdates(); asr?.startStream(101); lastWords = []; active = true;
}
async function diarize(flush) {
  while (true) {
    const first = cursor === 0;
    const start = first ? 0 : processor.audio_chunk_start(cursor);
    const count = first ? processor.num_samples_first_audio_chunk : processor.num_samples_per_audio_chunk;
    const available = base + pcm.length - start;
    if (available < count && !flush) break;
    if (available <= (first ? 0 : processor.feature_extractor.config.win_length)) break;
    const last = flush && available < count;
    const samples = pcm.slice(start - base, start - base + (last ? available : count));
    const featureStarted = performance.now();
    const inputs = await processor(samples, { is_streaming: true, is_first_audio_chunk: first, is_last_audio_chunk: last });
    speakerMetrics.speakerFeaturesMs += performance.now() - featureStarted;
    const speakerStarted = performance.now();
    const outputs = await model({ ...inputs, speaker_cache: cache, on_profile: timing => {
      for (const [key, value] of Object.entries(timing)) speakerMetrics[key] += value;
    } });
    speakerMetrics.speakerMs += performance.now() - speakerStarted; speakerMetrics.speakerCalls++;
    if (compareSpeakerOutputs) {
      const values = outputs.logits.data;
      const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      let hash = speakerMetrics.speakerOutputHash;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
      speakerMetrics.speakerOutputHash = hash; speakerMetrics.speakerOutputValues += values.length;
    }
    cache = outputs.speaker_cache;
    if (role === 'diar') {
      const logits = Float32Array.from(outputs.logits.data);
      postMessage({ type: 'activity', frames: outputs.logits.dims[1], logits: logits.buffer }, [logits.buffer]);
    } else updates.addActivity(outputs.logits.data, outputs.logits.dims[1]);
    outputs.logits.dispose(); inputs.input_features.dispose(); inputs.attention_mask.dispose();
    cursor += processor.num_mel_frames_per_step;
    const next = processor.audio_chunk_start(cursor);
    const remove = Math.max(0, Math.min(pcm.length, next - base));
    pcm = pcm.slice(remove); base += remove;
    if (last) break;
  }
}
function captions() {
  if (role === 'diar') return;
  if (role === 'asr') {
    const words = asr.words;
    const from = wordChangeStart(lastWords, words);
    if (from === words.length && from === lastWords.length) return;
    send('words', { from, words: words.slice(from) });
    lastWords = words.map(word => ({ ...word }));
    return;
  }
  const patch = updates.update(asr.words);
  if (patch) send('captions', patch);
}
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    if (data.type === 'load') {
      const loadStarted = performance.now();
      modelFiles = data.modelFiles || {};
      compareSpeakerOutputs = data.speakerCompareOutputs === true;
      assetBase = data.assetBase;
      if (!assetBase || new URL(assetBase).origin !== self.location.origin) throw Error('Invalid asset origin');
      const device = data.device || 'wasm';
      const profile = data.modelProfile || 'standard';
      if (!['standard', 'int8-dynamic', 'moonshine-tiny', 'moonshine-small'].includes(profile)) throw Error('Invalid speech model');
      if (profile !== 'standard' && device !== 'wasm') throw Error('The selected INT8 model requires CPU processing');
      if (!['wasm','webgpu'].includes(device)) throw Error('Invalid execution device');
      if (device === 'webgpu') {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter || adapter.info?.isFallbackAdapter) throw Error('Hardware WebGPU is unavailable. Choose CPU explicitly to continue.');
      }
      role = data.role || 'both';
      if (!['both','asr','diar'].includes(role)) throw Error('Invalid inference role');
      threads = self.crossOriginIsolated ? Math.max(1, Math.min(data.threads || 1, navigator.hardwareConcurrency || 1)) : 1;
      for (const runtime of [ort.env, env.backends.onnx]) {
        runtime.wasm.wasmPaths = new URL('ort/', assetBase).href; runtime.wasm.numThreads = threads; runtime.wasm.proxy = false;
      }
      if (role !== 'diar') {
        asr = profile.startsWith('moonshine-') ? new MoonshineBrowserASR() : new NemotronBrowserASR();
        await asr.load(status, { fixedShapes: data.fixedShapes !== false, profile, device, threads, readModel: name => readModelBuffer(modelFiles[(profile.startsWith('moonshine-') ? `${profile}/` : profile === 'int8-dynamic' ? 'asr-int8/' : 'asr/') + name]), wasmPaths: new URL('ort/', assetBase).href, jointMode: data.jointMode || 'argmax' });
      }
      if (role !== 'asr') {
        const runtimeOptions = data.speakerRuntimeOptions || {};
        for (const [key, value] of Object.entries(runtimeOptions)) {
          if (!['enableCpuMemArena', 'enableMemPattern', 'enableProfiling'].includes(key) || typeof value !== 'boolean') throw Error('Invalid speaker runtime option');
        }
        speakerRuntimeOptions = { enableCpuMemArena:false, enableMemPattern:false, enableProfiling:false, ...runtimeOptions };
        speakerProfiling = speakerRuntimeOptions.enableProfiling;
        if (speakerProfiling) {
          operatorProfile = createOperatorProfile();
          const originals = Object.fromEntries(['log', 'warn', 'error'].map(level=>[level, console[level]]));
          for (const [level, original] of Object.entries(originals)) {
            console[level] = (...args) => {
              if (!operatorProfile.consume(args.map(String).join(' '))) original.apply(console, args);
            };
          }
          restoreProfileConsole = () => Object.assign(console, originals);
        }
        status('Loading local speaker model');
        processor = await Nemotron3DiarizationProcessor.from_pretrained('diar', { local_files_only: true });
        const chunkFrames = data.speakerChunkFrames ?? 11;
        if (![9, 11, 12].includes(chunkFrames)) throw Error('Invalid speaker chunk size');
        // Custom chunk size; retain the recommended four-frame right context.
        processor.streaming_modes = { ...processor.streaming_modes, buffered: [chunkFrames, 4] };
        processor.set_streaming_mode('buffered');
        model = await Nemotron3DiarizationForAudioFrameClassification.from_pretrained('diar', { device, dtype: 'q8', local_files_only: true,
          session_options: { ...speakerRuntimeOptions, ...(data.speakerFixedBatch ? { freeDimensionOverrides: { batch_size: 1 } } : {}) } });
        const historyFrames = data.speakerHistoryFrames ?? 200;
        if (![150, 200, 264].includes(historyFrames)) throw Error('Invalid speaker history size');
        // Preserve the original 42-frame overlap when moving old FIFO frames
        // into the separate, unchanged speaker-identity cache.
        model.config.streaming_config = { ...model.config.streaming_config,
          fifo_length: historyFrames, speaker_cache_update_period: historyFrames - 42 };
      }
      if (device === 'webgpu' && ort.env.webgpu.device) ort.env.webgpu.device.lost.then(info => { active = false; send('error', { message: `GPU device lost: ${info.message || info.reason}. Reload models or choose CPU.` }); });
      loadMs = performance.now() - loadStarted;
      send('ready', { threads, role, device, loadMs, speakerRuntimeOptions, speakerChunkFrames: processor ? processor.num_mel_frames_per_step / processor.subsampling_factor : undefined, speakerLookaheadFrames: processor ? 4 : undefined, speakerHistoryFrames: model?.config.streaming_config.fifo_length });
    } else if (data.type === 'start') reset();
    else if (data.type === 'audio' && active) {
      const started = performance.now();
      const samples = new Float32Array(data.samples);
      totalSamples += samples.length;
      if (role !== 'asr') {
        const joined = new Float32Array(pcm.length + samples.length); joined.set(pcm); joined.set(samples, pcm.length); pcm = joined;
      }
      // ASR and diarization advance continuously, without waiting for silence.
      if (role === 'both') await processCaptionBatch(asr, samples, false, captions, diarize);
      else if (role === 'asr') { await asr.pushAudio(samples, false, captions); captions(); }
      else await diarize(false);
      elapsedMs += performance.now() - started;
      send('ack', { samples: samples.length, audioSeconds: totalSamples / 16000, elapsedMs, metrics: metrics() });
    } else if (data.type === 'stop' && active) {
      const started = performance.now();
      if (role === 'both') await processCaptionBatch(asr, new Float32Array(), true, captions, diarize);
      else if (role === 'asr') { await asr.pushAudio(new Float32Array(), true, captions); captions(); }
      else await diarize(true);
      elapsedMs += performance.now() - started;
      if (speakerProfiling && model) {
        model.sessions.model.endProfiling();
        await new Promise(resolve => setTimeout(resolve, 100));
        restoreProfileConsole?.();
        send('speaker-profile', { profile: operatorProfile.snapshot() });
      }
      pcm = new Float32Array(); cache = null; active = false; send('stopped', { elapsedMs, metrics: metrics(), audioSeconds: totalSamples / 16000 });
    }
  }).catch(error => { active = false; pcm = new Float32Array(); cache = null; send('error', { message: error.message || String(error) }); });
};
