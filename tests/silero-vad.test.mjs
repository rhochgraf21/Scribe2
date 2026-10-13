import { CaptionUpdates } from '../src/browser/caption-updates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechActivity } from '../src/browser/silero-vad.js';
const silent = async () => ({probability:0,state:new Float32Array(256)});
test('32 ms frames preserve context/state across arbitrary capture packets', async () => {
 const calls=[];
 const vad = new SpeechActivity(async (input,state) => { calls.push({input:input.slice(),state:state.slice()}); return {probability:.8,state:new Float32Array(256).fill(calls.length)}; });
 await vad.push(new Float32Array(300).fill(.1)); assert.equal(calls.length,0);
 await vad.push(new Float32Array(724).fill(.2)); assert.equal(calls.length,2);
 assert.equal(calls[1].input.length,576); assert.ok(calls[1].input.subarray(0,64).every(x=>Math.abs(x-.2)<1e-6));
 assert.equal(calls[1].state[0],1); assert.equal(vad.processed,1024); assert.equal(vad.pending.length,0);
 vad.reset(); assert.equal(vad.processed,0); assert.equal(vad.ranges.length,0); assert.equal(vad.state[0],0);
});
test('speech protects lead-in and tail; silence never skips unknown future audio', async () => {
 let frame=0;
 const vad = new SpeechActivity(async()=>({probability:frame++===20?.9:0,state:new Float32Array(256)}));
 await vad.push(new Float32Array(16000));
 assert.equal(vad.canSkip(0,6000),true);
 assert.equal(vad.canSkip(8800,9000),false); // protected lead-in
 assert.equal(vad.canSkip(12000,12300),false); // protected tail
 assert.equal(vad.canSkip(15000,16000),false);
 await vad.push(new Float32Array(16000));
 assert.equal(vad.canSkip(8200,8400),true); // outside shorter lead-in
 assert.equal(vad.canSkip(12500,12800),true); // outside shorter tail
 assert.equal(vad.canSkip(16000,24000),true);
 vad.discardBefore(16000); assert.equal(vad.ranges.length,0);
});
test('sustained silence has bounded storage and invalid probabilities fail open at caller', async () => {
 const vad = new SpeechActivity(silent);
 for(let i=0;i<100;i++) { await vad.push(new Float32Array(8960)); vad.discardBefore(vad.processed-20000); }
 assert.equal(vad.ranges.length,0); assert.ok(vad.pending.length<512);
 const bad = new SpeechActivity(async()=>({probability:NaN,state:new Float32Array(256)}));
 await assert.rejects(bad.push(new Float32Array(512)),/Invalid VAD/);
});

test('inactive skipped frames preserve speaker attribution timing after a pause', () => {
 const updates = new CaptionUpdates();
 updates.addActivity(new Float32Array(200*8).fill(-100),200);
 const speech = new Float32Array(100*8).fill(-100);
 for(let f=0;f<100;f++) speech[f*8+3]=10;
 updates.addActivity(speech,100);
 const patch=updates.update([{text:'hello',time:2.5,stable:true}]);
 assert.equal(updates.frameEnd,300);
 assert.equal(patch.segments[0].speaker,1);
});
