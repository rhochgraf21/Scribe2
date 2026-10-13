import test from 'node:test';
import assert from 'node:assert/strict';
import { padWasm, uleb } from '../scripts/pad-wasm.mjs';
const section=(id,payload)=>Buffer.concat([Buffer.from([id]),uleb(payload.length),Buffer.from(payload)]);
const moduleFor=body=>Buffer.concat([
 Buffer.from([0,97,115,109,1,0,0,0]),section(1,[1,0x60,0,1,0x7f]),section(3,[1,0]),
 section(7,[1,1,102,0,0]),section(10,Buffer.concat([Buffer.from([1]),uleb(body.length),Buffer.from(body)])),
 section(0,[1,120,10,20,30]),
]);
test('padding preserves normal and early-return function results and custom sections',async()=>{
 for(const body of [[0,0x41,42,0x0b],[0,0x41,42,0x0f,0x0b]]) {
  const source=moduleFor(body), result=padWasm(source,{minimum:1,target:160000});
  assert.equal(result.changed.length,1);assert.equal(result.changed[0].paddedBytes,160000);
  assert.ok(WebAssembly.validate(result.bytes));
  const original=await WebAssembly.instantiate(source), padded=await WebAssembly.instantiate(result.bytes);
  assert.equal(original.instance.exports.f(),42);assert.equal(padded.instance.exports.f(),42);
  assert.deepEqual(WebAssembly.Module.customSections(original.module,'x'),WebAssembly.Module.customSections(padded.module,'x'));
  assert.deepEqual(padWasm(result.bytes).bytes,result.bytes);
 }
});
test('small functions remain byte-identical and malformed modules are rejected',()=>{
 const original=moduleFor([0,0x41,42,0x0b]);assert.deepEqual(padWasm(original).bytes,original);
 assert.throws(()=>padWasm(Buffer.from([0,1,2])),/header/);
 assert.throws(()=>padWasm(original.subarray(0,-1)),/Truncated/);
});
