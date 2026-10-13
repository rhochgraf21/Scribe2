import test from 'node:test';
import assert from 'node:assert/strict';
import { installGpuDiagnostics } from '../src/browser/gpu-diagnostics.js';
import { DiagnosticRecorder, LOG_KEY } from '../src/browser/diagnostic-recorder.js';
test('GPU observer preserves device requests and records errors before termination',async()=>{
 const events=[]; let lost, listener, received;
 const device={addEventListener(type,fn){assert.equal(type,'uncapturederror');listener=fn;},lost:new Promise(r=>lost=r)};
 class Adapter { async requestDevice(options){received=options;return device;} }
 const observe=installGpuDiagnostics({GPUAdapter:Adapter},fault=>events.push(fault),message=>events.push({fatal:message}));
 const descriptor={requiredFeatures:['shader-f16']};
 assert.equal(await new Adapter().requestDevice(descriptor),device); assert.equal(received,descriptor);
 observe(device); assert.equal(events.length,1);
 listener({error:new Error('validation test')}); assert.equal(events.at(-1).kind,'gpu-uncaptured');
 lost({reason:'unknown',message:'driver reset'}); await Promise.resolve();
 assert.equal(events.at(-2).kind,'gpu-device-lost'); assert.equal(events.at(-2).message,'driver reset'); assert.ok(events.at(-1).fatal);
});
test('failed GPU request propagates original exception and missing hooks are reported',async()=>{
 const events=[];const error=new Error('request rejected');
 class Adapter {async requestDevice(){throw error;}}
 installGpuDiagnostics({GPUAdapter:Adapter},e=>events.push(e),()=>{});
 await assert.rejects(new Adapter().requestDevice(),e=>e===error);
 assert.equal(events[0].kind,'gpu-device-request');
 installGpuDiagnostics({},e=>events.push(e),()=>{}); assert.equal(events.at(-1).kind,'gpu-observer-unavailable');
});
test('GPU fault details persist immediately and remain bounded separately from samples',()=>{
 const values=new Map(),store={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const r=new DiagnosticRecorder(store); r.begin({diarizationOnly:true});
 for(let i=0;i<40;i++)r.fault({kind:'gpu-uncaptured',message:'bad https://example.com/private '+ 'x'.repeat(2000),stage:'speaker-inference-start',audio:'PRIVATE'});
 const saved=JSON.parse(values.get(LOG_KEY));assert.equal(saved.faults.length,32);
 assert.equal(saved.config.diarizationOnly,true);assert.equal(saved.points.at(-1).event,'diagnostic-fault');
 assert.equal(saved.faults[0].message.length,1500);assert.ok(!values.get(LOG_KEY).includes('PRIVATE'));assert.ok(!values.get(LOG_KEY).includes('example.com'));
});
test('runtime selection and fetched padded artifact survive diagnostic persistence',()=>{
 const values=new Map(),store={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const r=new DiagnosticRecorder(store); r.begin({wasmPadding:true});
 const runtime={version:'test',variant:'asyncify-padded',configuredWasm:'ort-wasm-simd-threaded.asyncify.padded.wasm',jspiSupported:false};
 r.runtime(runtime);
 r.runtime({...runtime,requestedWasm:runtime.configuredWasm,audio:'PRIVATE'});
 const saved=JSON.parse(values.get(LOG_KEY));
 assert.equal(saved.config.wasmPadding,true);
 assert.equal(saved.runtimes.length,1);
 assert.equal(saved.runtimes[0].requestedWasm,runtime.configuredWasm);
 assert.equal(saved.runtimes[0].jspiSupported,false);
 assert.equal(saved.points.at(-1).event,'runtime-info');
 assert.ok(!values.get(LOG_KEY).includes('PRIVATE'));
});
