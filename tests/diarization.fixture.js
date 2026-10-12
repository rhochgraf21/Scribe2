// Test-only entry: never included in the production site.
window.runDiarization = async ({ dtype, device = 'wasm', pcmBase64 }) => {
 const worker = new Worker(new URL('./diarization.worker.js', import.meta.url), { type:'module' });
 const graph = dtype === 'q8' ? 'model_quantized' : `model_${dtype}`;
 const paths = ['config.json','preprocessor_config.json','processor_config.json',`onnx/${graph}.onnx`,`onnx/${graph}.onnx_data`];
 let failure, pending, ready, stopped, fixtureReady;
 const fixtureLoaded = new Promise(resolve => fixtureReady = resolve);
 const loaded = new Promise(resolve => ready = resolve);
 const finished = new Promise(resolve => stopped = resolve);
 const report = { dtype, device, logits:[], frames:0, finite:true };
 worker.onerror = e => { failure = e.message; ready(); stopped(); pending?.(); };
 worker.onmessage = ({data}) => {
  if (data.type === 'fixture-ready') fixtureReady();
  if (data.type === 'wasm-memory') report.peakWasmBytes = Math.max(report.peakWasmBytes || 0, data.bytes);
  if (data.type === 'error') { failure = data.message; ready(); stopped(); pending?.(); }
  if (data.type === 'ready') { report.loadMs = data.loadMs; ready(); }
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
   return [`diar/${path}`,await response.blob()];
  })));
  await fixtureLoaded;
  worker.postMessage({type:'load',role:'diar',device,speakerDtype:dtype,threads:4,modelFiles,assetBase:new URL('/',location.href).href});
  await loaded; check();
  const bytes = Uint8Array.from(atob(pcmBase64), c => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer); report.seconds = pcm.length/16000;
  const begin = performance.now(); worker.postMessage({type:'start'});
  for(let offset=0;offset<pcm.length;offset+=8960) {
   const samples=Float32Array.from(pcm.subarray(offset,offset+8960),x=>x/32768);
   const ack = new Promise(resolve => pending = resolve);
   worker.postMessage({type:'audio',samples:samples.buffer},[samples.buffer]);
   await ack; check();
  }
  worker.postMessage({type:'stop'}); await finished; check();
  report.wallMs = performance.now()-begin;
  return report;
 } finally { worker.terminate(); }
};
