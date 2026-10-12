import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceClient, threadPlan } from '../src/browser/inference-client.js';
function harness(mode='parallel') {
  const workers=[], messages=[];
  const client=new InferenceClient({mode,hardware:12,isolated:true,workerFactory:()=>{
    const worker={sent:[],postMessage(data,transfer){this.sent.push({data,transfer});},terminate(){this.terminated=true;},emit(data){this.onmessage({data});}};
    workers.push(worker);return worker;
  }});
  client.onmessage=({data})=>messages.push(data);
  return {client,workers,messages};
}
test('separate runtimes share one bounded thread budget, with single-core fallback',()=>{
  assert.deepEqual(threadPlan('parallel',12,true),{mode:'parallel',asr:2,diar:2,budget:4});
  assert.deepEqual(threadPlan('parallel',2,true),{mode:'parallel',asr:1,diar:1,budget:2});
  assert.equal(threadPlan('parallel',12,false).mode,'sequential');
  assert.equal(threadPlan('parallel',1,true).both,1);
});
test('speech publishes before speaker results, while acknowledgements track the slower worker',()=>{
  const {client,workers:[asr,diar],messages}=harness();
  client.postMessage({type:'load'});
  assert.equal(asr.sent[0].data.threads,2);assert.equal(diar.sent.length,0);
  asr.emit({type:'ready'});assert.equal(diar.sent[0].data.threads,2);assert.equal(messages.at(-1).type,'status');
  diar.emit({type:'ready'});assert.equal(messages.at(-1).type,'ready');
  client.postMessage({type:'start'});
  asr.emit({type:'words',from:0,words:[{text:'Hello',time:.1}]});
  assert.equal(messages.at(-1).segments[0].text,'Hello');
  assert.equal(messages.at(-1).segments[0].speaker,null);
  asr.emit({type:'ack',samples:8960,elapsedMs:100});
  assert.equal(messages.filter(m=>m.type==='ack').length,0);
  const logits=new Float32Array(30*8).fill(-5);for(let f=0;f<30;f++)logits[f*8+2]=5;
  diar.emit({type:'activity',frames:30,logits:logits.buffer});
  assert.equal(messages.at(-1).segments[0].speaker,1);
  assert.equal(messages.at(-1).segments[0].id,'word-0');
  diar.emit({type:'ack',samples:4000,elapsedMs:200});
  assert.equal(messages.at(-1).samples,4000);
  diar.emit({type:'ack',samples:4960,elapsedMs:300});
  assert.equal(messages.at(-1).samples,4960);
  asr.emit({type:'stopped',elapsedMs:120});
  assert.notEqual(messages.at(-1).type,'stopped');
  diar.emit({type:'stopped',elapsedMs:320});
  assert.equal(messages.at(-1).type,'stopped');
});
test('audio is transferred to both workers and errors terminate both',()=>{
  const {client,workers,messages}=harness();
  const samples=new Float32Array([.1,.2]).buffer;
  client.postMessage({type:'audio',samples});
  assert.notEqual(workers[0].sent[0].data.samples,workers[1].sent[0].data.samples);
  for(const worker of workers)assert.deepEqual(new Float32Array(worker.sent[0].data.samples),new Float32Array(samples));
  workers[1].emit({type:'error',message:'test failure'});
  assert.equal(messages.at(-1).type,'error');
  assert.ok(workers.every(w=>w.terminated));
  const before=messages.length;workers[0].emit({type:'captions'});assert.equal(messages.length,before);
});
test('starting another conversation clears incremental words and attribution',()=>{
  const {client,workers:[asr],messages}=harness();
  asr.emit({type:'words',from:0,words:[{text:'Old',time:0}]});
  client.postMessage({type:'start'});
  asr.emit({type:'words',from:0,words:[{text:'New',time:0}]});
  assert.deepEqual(messages.at(-1).segments.map(s=>s.text),['New']);
});
test('WebGPU uses independent GPU workers and never retries on CPU',()=>{
  const workers=[],events=[];
  const client=new InferenceClient({device:'webgpu',hardware:8,isolated:true,workerFactory:()=>{
    const worker={sent:[],postMessage(data){this.sent.push(data);},terminate(){this.terminated=true;}};
    workers.push(worker);return worker;
  }});
  client.onmessage=({data})=>events.push(data);
  client.postMessage({type:'load'});
  assert.equal(workers.length,2);
  assert.equal(workers[0].sent[0].device,'webgpu');
  assert.equal(workers[0].sent[0].threads,1);
  assert.equal(workers[1].sent.length,0);
  workers[0].onmessage({data:{type:'ready'}});
  assert.equal(workers[1].sent[0].device,'webgpu');
  assert.equal(workers[1].sent[0].threads,3);
  workers[1].onmessage({data:{type:'ready'}});
  assert.equal(events.at(-1).device,'webgpu');
  workers[0].onmessage({data:{type:'ack',samples:1600,elapsedMs:10}});
  assert.equal(events.at(-1).samples,1600); // no speaker acknowledgement needed
  client.postMessage({type:'audio',samples:new Float32Array(16*16000).buffer});
  assert.equal(events.at(-1).type,'warning');
  assert.ok(workers[1].terminated); assert.ok(!workers[0].terminated);
  assert.ok(client.updates.speakerDetectionEnded);
  workers[0].onmessage({data:{type:'stopped',elapsedMs:10}});
  assert.equal(events.at(-1).type,'stopped');
  workers[0].onmessage({data:{type:'error',message:'GPU unavailable'}});
  assert.equal(events.at(-1).message,'GPU unavailable');
  assert.ok(workers.every(w=>w.terminated));
  assert.throws(()=>new InferenceClient({device:'remote'}),/Invalid execution device/);
});

test('CPU model profile and files reach the speech worker, with separate speaker files',()=>{
  const {client,workers:[asr,diar]}=harness();
  client.postMessage({type:'load',modelProfile:'int8-dynamic',speakerChunkFrames:11,speakerHistoryFrames:200,modelFiles:{'asr-int8/int8-dynamic/encoder_model.onnx':{},'diar/config.json':{}}});
  assert.equal(asr.sent[0].data.modelProfile,'int8-dynamic');
  assert.deepEqual(Object.keys(asr.sent[0].data.modelFiles),['asr-int8/int8-dynamic/encoder_model.onnx']);
  asr.emit({type:'ready'});
  assert.deepEqual(Object.keys(diar.sent[0].data.modelFiles),['diar/config.json']);
  assert.equal(diar.sent[0].data.speakerChunkFrames,11);
  assert.equal(diar.sent[0].data.speakerHistoryFrames,200);
  diar.emit({type:'ready',speakerChunkFrames:11,speakerLookaheadFrames:4,speakerHistoryFrames:200,speakerRuntimeOptions:{enableCpuMemArena:true,enableMemPattern:false,enableProfiling:false}});
  assert.equal(client.diagnostics().workers[1].speakerChunkFrames,11);
  assert.equal(client.diagnostics().workers[1].speakerLookaheadFrames,4);
  assert.equal(client.diagnostics().workers[1].speakerHistoryFrames,200);
  assert.equal(client.diagnostics().workers[1].speakerRuntimeOptions.enableCpuMemArena,true);
  assert.equal(client.diagnostics().workers[1].speakerRuntimeOptions.enableMemPattern,false);
});

test('thread budget is bounded by device cores and isolation',()=>{
  assert.deepEqual(threadPlan('parallel',12,true,'wasm',6),{mode:'parallel',asr:2,diar:4,budget:6});
  assert.deepEqual(threadPlan('parallel',4,true,'wasm',6),{mode:'parallel',asr:2,diar:2,budget:4});
  assert.equal(threadPlan('parallel',12,false,'wasm',6).both,1);
  assert.equal(threadPlan('sequential',12,true,'wasm',2).both,2);
  assert.equal(threadPlan('sequential',2,true,'wasm',8).both,2);
  assert.equal(threadPlan('parallel',12,false,'wasm',8).both,1);
  const plan=threadPlan('parallel',12,true,'wasm',8);
  assert.equal(plan.asr+plan.diar,8);
  assert.throws(()=>threadPlan('sequential',12,true,'wasm',99),/Invalid/);
});
test('diagnostics distinguish worker queues and stage timings and reset with the session',()=>{
  const {client,workers:[asr,diar],messages}=harness();
  client.postMessage({type:'start'});
  client.postMessage({type:'audio',samples:new Float32Array(16000).buffer});
  asr.emit({type:'ack',samples:16000,elapsedMs:500,metrics:{encoderMs:450,decoderMs:50}});
  diar.emit({type:'ack',samples:8000,elapsedMs:200,metrics:{speakerMs:180,speakerInferenceMs:175,speakerCacheMs:2,speakerTensorMs:3}});
  const report=messages.at(-1).diagnostics;
  assert.equal(report.capturedSeconds,1);
  assert.equal(report.workers[0].queuedSeconds,0);
  assert.equal(report.workers[1].queuedSeconds,.5);
  assert.equal(report.workers[0].metrics.encoderMs,450);
  assert.equal(report.workers[1].metrics.speakerMs,180);
  assert.equal(report.workers[1].metrics.speakerInferenceMs,175);
  assert.equal(report.workers[1].metrics.speakerCacheMs,2);
  assert.equal(report.workers[1].metrics.speakerTensorMs,3);
  assert.ok(!('words' in report));
  client.postMessage({type:'start'});
  assert.equal(client.diagnostics().capturedSeconds,0);
  assert.deepEqual(client.diagnostics().workers[0].metrics,{});
  assert.deepEqual(client.diagnostics().workers[1].metrics,{});
});

test('six requested CPU threads fall back to one without isolation, even on ten cores', () => {
  assert.deepEqual(threadPlan('parallel', 10, false, 'wasm', 6), { mode:'sequential', both:1, budget:1 });
  assert.deepEqual(threadPlan('parallel', 10, true, 'wasm', 6), { mode:'parallel', asr:2, diar:4, budget:6 });
  assert.deepEqual(threadPlan('sequential', 10, true, 'wasm', 6), { mode:'sequential', both:6, budget:6 });
});

test('Moonshine model files are routed to speech only for both sizes',()=>{
  for (const modelProfile of ['moonshine-tiny','moonshine-small']) {
    const {client,workers:[asr,diar]}=harness();
    const path=`${modelProfile}/frontend.onnx`;
    client.postMessage({type:'load',modelProfile,modelFiles:{[path]:{},'diar/config.json':{}}});
    assert.deepEqual(Object.keys(asr.sent[0].data.modelFiles),[path]);
    assert.equal(asr.sent[0].data.modelProfile,modelProfile);
    asr.emit({type:'ready'});
    assert.deepEqual(Object.keys(diar.sent[0].data.modelFiles),['diar/config.json']);
  }
});
