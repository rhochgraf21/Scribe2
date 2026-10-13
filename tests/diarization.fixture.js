// Test-only entry: never included in the production site.
window.runDiarization = async ({ dtype, device = 'wasm', pcmBase64, hybrid = false, wasmPadding = false, injectSilence = false, speakerSilenceSkipping = true }) => {
 const worker = new Worker(new URL('./diarization.worker.js', import.meta.url), { type:'module' });
 const graph = dtype === 'q8' ? 'model_quantized' : `model_${dtype}`;
 const paths = ['config.json','preprocessor_config.json','processor_config.json',`onnx/${graph}.onnx`,`onnx/${graph}.onnx_data`];
 if (hybrid) paths.push(...['frontend.onnx','cross_kv_int8.onnx','adapter_int8.onnx','tokenizer.json','tokenizer_config.json','encoder_int8.onnx','decoder_kv_int8.onnx','streaming_config.json'].map(p => '../moonshine-tiny/' + p));
 let failure, pending, ready, stopped, fixtureReady;
 const fixtureLoaded = new Promise(resolve => fixtureReady = resolve);
 const loaded = new Promise(resolve => ready = resolve);
 const finished = new Promise(resolve => stopped = resolve);
 const report = { wasmPadding, injectSilence, speakerSilenceSkipping, faults:[], dtype, device:hybrid ? 'hybrid' : device, logits:[], frames:0, finite:true };
 worker.onerror = e => { failure = e.message; ready(); stopped(); pending?.(); };
 worker.onmessage = ({data}) => {
  if (data.type === 'runtime-info') report.runtime = data.runtime;
  if (data.type === 'diagnostic-fault') report.faults.push(data.fault);
  if (data.type === 'memory') report.observedMemory = data.memory;
  if (data.type === 'fixture-ready') fixtureReady();
  if (data.type === 'wasm-memory') report.peakWasmBytes = Math.max(report.peakWasmBytes || 0, data.bytes);
  if (data.type === 'error') { failure = data.message; ready(); stopped(); pending?.(); }
  if (data.type === 'ready') { report.loadMs = data.loadMs; report.historyFrames = data.speakerHistoryFrames; report.speechDevice = data.speechDevice; report.speakerDevice = data.speakerDevice; ready(); }
  if (data.type === 'captions') { report.captionUpdates = (report.captionUpdates || 0) + 1; }
  if (data.type === 'activity') {
   const values = new Float32Array(data.logits);
   report.finite &&= values.every(Number.isFinite);
   report.logits.push(...values); report.frames += data.frames;
  }
  if (data.type === 'ack') { pending?.(); pending = null; }
  if (data.type === 'stopped') { report.computeMs = data.elapsedMs; report.metrics = data.metrics; stopped(); }
 };
 const check = () => { if (failure) throw Error(failure); };
 try {
  const modelFiles = Object.fromEntries(await Promise.all(paths.map(async path => {
   const response = await fetch(`/models/diar/${path}`); if (!response.ok) throw Error(`Missing ${path}`);
   return [path.startsWith('../') ? path.slice(3) : `diar/${path}`,await response.blob()];
  })));
  await fixtureLoaded;
  worker.postMessage({type:'load',wasmPadding,speakerSilenceSkipping,role:hybrid ? 'both' : 'diar',modelProfile:hybrid ? 'moonshine-tiny' : 'standard',device:hybrid ? 'hybrid' : device,speakerDtype:dtype,speakerCompareOutputs:hybrid,threads:4,modelFiles,assetBase:new URL('/',location.href).href});
  await loaded; check();
  const bytes = Uint8Array.from(atob(pcmBase64), c => c.charCodeAt(0));
  let pcm = new Int16Array(bytes.buffer);
  if (injectSilence) {
   const split = Math.floor(pcm.length/2), padded = new Int16Array(pcm.length + 12*16000);
   padded.set(pcm.subarray(0,split),4*16000);
   padded.set(pcm.subarray(split),8*16000+split); pcm = padded;
  }
  report.seconds = pcm.length/16000;
  const begin = performance.now(); worker.postMessage({type:'start'});
  for(let offset=0;offset<pcm.length;offset+=8960) {
   const samples=Float32Array.from(pcm.subarray(offset,offset+8960),x=>x/32768);
   const ack = new Promise(resolve => pending = resolve);
   worker.postMessage({type:'audio',samples:samples.buffer},[samples.buffer]);
   await ack; check();
  }
  worker.postMessage({type:'stop'}); await finished; check();
  if (hybrid) { report.frames = report.metrics.speakerOutputValues / 8; report.finite = report.metrics.speakerOutputsFinite; }
  if (speakerSilenceSkipping && !(report.metrics.vadFrames > 0)) throw Error('Silero did not run');
  if (injectSilence && speakerSilenceSkipping && !(report.metrics.speakerSkippedSeconds > 5)) throw Error('Silence was not skipped');
  if (Math.abs(report.frames - report.seconds*100) > 2) throw Error('Speaker timeline drifted');
  if (report.historyFrames !== 125) throw Error('Expected 10-second speaker history');
  if (hybrid && (!report.captionUpdates || report.speechDevice !== 'wasm' || report.speakerDevice !== 'webgpu')) throw Error('Mixed caption processing failed');
  if (!(report.observedMemory?.wasmBytes > 0)) throw Error('Production WASM probe did not observe memory');
  if (wasmPadding && report.runtime?.requestedWasm !== 'ort-wasm-simd-threaded.asyncify.padded.wasm') throw Error('Padded artifact was not requested');
  report.wallMs = performance.now()-begin;
  return report;
 } finally { worker.terminate(); }
};
