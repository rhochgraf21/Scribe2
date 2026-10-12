import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSpeaker, transcriptText } from '../src/browser/speaker-names.js';
import { applyCaptionPatch } from '../src/browser/caption-updates.js';
test('names survive live text and speaker revisions and appear in exports', () => {
  let session = { segments: [{id:'1',speaker:1,text:'Hello'}] };
  const held = structuredClone(session);
  session = renameSpeaker(session, 1, ' Alice ');
  session = applyCaptionPatch(session, {from:0,segments:[{id:'1',speaker:2,text:'Hello'},{id:'2',speaker:1,text:'Good morning'}]});
  assert.deepEqual(session.speakers, {1:'Alice'});
  assert.equal(transcriptText(session), '[Speaker 2] Hello\n[Alice] Good morning');
  assert.equal(transcriptText(renameSpeaker(held,1,'Alice')), '[Alice] Hello');
  assert.equal(held.speakers, undefined);
});
test('rejects empty names and unidentified speakers', () => {
  for (const id of [null,0,'__proto__']) assert.throws(()=>renameSpeaker({segments:[]},id,'Alice'));
  for (const name of ['   ','a'.repeat(81)]) assert.throws(()=>renameSpeaker({segments:[]},1,name));
});
