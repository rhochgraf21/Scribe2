import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticRecorder, LOG_KEY, PREVIOUS_KEY } from '../src/browser/diagnostic-recorder.js';
const storage = () => { const values = new Map(); return { getItem:k=>values.get(k), setItem:(k,v)=>values.set(k,v), removeItem:k=>values.delete(k) }; };
test('checkpoints survive abrupt termination and preserve previous run through new load', () => {
 const store=storage(); const first=new DiagnosticRecorder(store,()=>100);
 first.begin({modelProfile:'moonshine-tiny',device:'hybrid'}); first.record('start');
 first.record('sample',{capturedSeconds:12,workers:[{role:'both',memory:{wasmBytes:1234},metrics:{speakerMs:50}}]});
 const reopened=new DiagnosticRecorder(store,()=>200);
 assert.equal(reopened.previous.state,'running');
 assert.equal(reopened.previous.points.at(-1).workers[0].memory.wasmBytes,1234);
 reopened.begin({device:'wasm'});
 assert.equal(JSON.parse(store.getItem(PREVIOUS_KEY)).startedAt,100);
 assert.equal(JSON.parse(store.getItem(LOG_KEY)).startedAt,200);
 reopened.record('stopped'); assert.equal(reopened.current.state,'ready');
 reopened.clear(); assert.equal(store.getItem(LOG_KEY),undefined); assert.equal(store.getItem(PREVIOUS_KEY),undefined);
});
test('bounded logs retain exactly the latest 960 entries and exclude private payloads',()=>{
 const store=storage(); const recorder=new DiagnosticRecorder(store);
 recorder.begin({device:'wasm',name:'PRIVATE'});
 for(let i=0;i<1100;i++) recorder.record('sample',{capturedSeconds:i,words:['PRIVATE'],workers:[{role:'both',words:['PRIVATE'],metrics:{speakerMs:i,text:'PRIVATE'},memory:{wasmBytes:10}}]}, {segmentCount:i,text:'PRIVATE'});
 const saved=store.getItem(LOG_KEY);
 assert.ok(!saved.includes('PRIVATE'));
 assert.equal(recorder.current.points.length,960); assert.equal(recorder.current.points[0].capturedSeconds,140);
 assert.equal(JSON.parse(saved).points.length,960); assert.equal(JSON.parse(saved).points[0].capturedSeconds,140);
 assert.equal(recorder.current.points.at(-1).capturedSeconds,1099);
});
test('corrupt or blocked storage never prevents inference; current log remains exportable',()=>{
 const store=storage(); store.setItem(LOG_KEY,'{broken');
 const recorder=new DiagnosticRecorder(store); assert.equal(recorder.previous,null);
 const denied=new DiagnosticRecorder({getItem(){throw Error('denied');},setItem(){throw Error('quota');},removeItem(){throw Error('denied');}});
 assert.doesNotThrow(()=>{denied.begin({});denied.record('error');});
 assert.equal(denied.available,false); assert.equal(denied.current.state,'error');
 assert.doesNotThrow(()=>denied.clear());
});

test('sparse checkpoints and lifecycle events are immediately persisted',()=>{
 const store=storage(); let now=1000, writes=0;
 const set=store.setItem; store.setItem=(k,v)=>{writes++;set(k,v);};
 const recorder=new DiagnosticRecorder(store,()=>now); recorder.begin({device:'hybrid'});
 assert.equal(recorder.current.sampleIntervalMs,10000);
 const initialWrites=writes;
 for(let i=1;i<=20;i++) {
  now+=10000; recorder.record('sample',{capturedSeconds:i*10});
  const saved=JSON.parse(store.getItem(LOG_KEY));
  assert.equal(saved.points.at(-1).at,now);
  assert.equal(saved.points.at(-1).capturedSeconds,i*10);
  assert.equal(writes,initialWrites+i);
 }
 assert.equal(new DiagnosticRecorder(store).previous.points.at(-1).at,now);
});
