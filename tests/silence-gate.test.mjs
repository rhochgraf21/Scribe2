import test from 'node:test';
import assert from 'node:assert/strict';
import { SilenceGate } from '../src/browser/silence-gate.js';
import { CaptionUpdates } from '../src/browser/caption-updates.js';
test('silence guard keeps boundaries, resumes on a brief onset, and resets per session', () => {
 const gate = new SilenceGate(), quiet = new Float32Array(19200);
 assert.equal(gate.shouldSkip(quiet,.88,false),false);
 assert.equal(gate.shouldSkip(quiet,.88),true);
 const onset = quiet.slice(); onset[onset.length-1]=.003;
 assert.equal(gate.shouldSkip(onset,.88),false);
 assert.equal(gate.shouldSkip(quiet,.88),false);
 assert.equal(gate.shouldSkip(quiet,.88),true);
 assert.equal(gate.shouldSkip(quiet,.4,false),false); // always process the final partial chunk
 gate.reset(); assert.equal(gate.shouldSkip(quiet,.88),false);
});
test('short-window RMS protects quiet speech; noise and invalid input never skip', () => {
 for(const sample of [.0008,.01,NaN,Infinity]) {
  const gate = new SilenceGate(), audio = new Float32Array(19200);
  gate.shouldSkip(audio,2);
  audio.fill(sample,320,640);
  assert.equal(gate.shouldSkip(audio,.88),false);
 }
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
