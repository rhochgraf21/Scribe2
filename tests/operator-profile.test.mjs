import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorProfile } from '../src/browser/operator-profile.js';
const kernel = (name, duration, op='MatMul') => JSON.stringify({cat:'Node',name:name+'_kernel_time',dur:duration,args:{op_name:op,provider:'CPUExecutionProvider'}})+',';
test('WASM trace aggregation converts units, excludes non-kernel events and separates warmed calls',()=>{
  const p=createOperatorProfile();
  assert.equal(p.consume('warning: no trace'),false);
  assert.equal(p.consume('{not json'),false);
  p.consume('['); p.consume(kernel('one',2000));
  p.consume(JSON.stringify({cat:'Node',name:'one_fence_before',dur:90000}));
  for(let i=0;i<46;i++)p.consume(JSON.stringify({cat:'Session',name:'model_run',dur:5000}));
  p.consume(kernel('one',1000));p.consume(kernel('two',500,'Softmax'));p.consume(']');
  const r=p.snapshot();assert.equal(r.runs,46);assert.equal(r.events,3);
  assert.deepEqual(r.operators[0],{name:'CPUExecutionProvider / MatMul',calls:2,totalMs:3,maxMs:2,steadyCalls:1,steadyMs:1});
  assert.equal(r.nodes.length,2);assert.equal(r.operators[1].totalMs,.5);
  r.operators[0].totalMs=999;assert.equal(p.snapshot().operators[0].totalMs,3);
});
