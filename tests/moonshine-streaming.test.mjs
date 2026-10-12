import test from 'node:test';
import assert from 'node:assert/strict';
import { reviseWords, wordChangeStart } from '../src/browser/moonshine-words.js';
import { CaptionUpdates, applyCaptionPatch } from '../src/browser/caption-updates.js';
import { modelProfiles } from '../src/browser/model-import.js';

test('Moonshine hypotheses revise earlier words and shrink without leaving stale captions', () => {
  const updates = new CaptionUpdates();
  const logits = new Float32Array(500 * 8).fill(-5);
  for (let i = 0; i < 500; i++) logits[i * 8 + 1] = 5;
  updates.addActivity(logits, 500);
  let words = reviseWords([], 'We can hear a voice', 0, 2, false);
  let session = applyCaptionPatch({ segments: [] }, updates.update(words));
  assert.equal(updates.finalized, 0);
  const revised = reviseWords(words, 'You hear a voice', 0, 2, false);
  assert.equal(wordChangeStart(words, revised), 0);
  session = applyCaptionPatch(session, updates.update(revised));
  assert.equal(session.segments.map(s => s.text).join(' '), 'You hear a voice');
  words = reviseWords(revised, 'You hear', 0, 2, true);
  session = applyCaptionPatch(session, updates.update(words));
  assert.equal(session.segments.length, 2);
  assert.ok(session.segments.every(s => s.speaker === 1));
  assert.equal(updates.finalized, 2);
});

test('unchanged words retain timing while completion is still sent to speaker attribution', () => {
  const before = reviseWords([], 'Hello there', 1, 2, false);
  const after = reviseWords(before, 'Hello there friend', 1, 3, false);
  assert.equal(after[0].time, before[0].time);
  assert.equal(after[1].time, before[1].time);
  assert.equal(wordChangeStart(before, after), 2);
  const final = reviseWords(after, 'Hello there friend', 1, 3, true);
  assert.equal(wordChangeStart(after, final), 0);
  assert.equal(wordChangeStart(final, final), 3);
  assert.deepEqual(reviseWords(before, '', 1, 2, true), []);
});

test('both Moonshine profiles select CPU and five graphs under 256 MB plus shared diarization', () => {
  for (const name of ['moonshine-tiny', 'moonshine-small']) {
    const profile = modelProfiles[name];
    assert.equal(profile.cpuOnly, true);
    const speech = profile.entries.filter(e => e.path.startsWith(`${name}/`));
    assert.equal(speech.filter(e => e.path.endsWith('.onnx')).length, 5);
    assert.ok(speech.reduce((n, e) => n + e.size, 0) < 256e6);
    assert.ok(profile.entries.some(e => e.path.startsWith('diar/')));
    assert.ok(!profile.entries.some(e => e.path.startsWith('asr')));
  }
});

test('speaker history survives a revised first word and is bounded during silence', () => {
  const updates = new CaptionUpdates();
  const logits = new Float32Array(2000 * 8).fill(-5);
  for (let i = 0; i < 2000; i++) logits[i * 8 + 2] = 5;
  updates.addActivity(logits, 2000);
  const words = reviseWords([], 'Later words', 5, 15, false);
  updates.update(words);
  assert.equal(updates.activityBase, 492);
  const revised = reviseWords(words, 'Many more words now', 5, 15, true);
  const patch = updates.update(revised);
  assert.ok(patch.segments.every(s => s.speaker === 1));
  assert.equal(updates.finalized, 4);
  updates.addActivity(new Float32Array(10000 * 8), 10000);
  updates.update(revised);
  assert.equal(updates.activity.length, 1600);
});

test('audio framing flushes a short tail, silence produces no phrase, and restart clears state', async () => {
  const { MoonshineBrowserASR } = await import('../src/browser/moonshine-streaming.js');
  const asr = new MoonshineBrowserASR();
  asr.config = { frontend_state_shapes: {} };
  asr.startStream();
  const phrases = [];
  asr.update = async function(final) {
    if (final) { phrases.push({start:this.segmentStart, samples:this.segmentSamples}); this.clearSegment(); }
    else this.toEncode = new Float32Array();
  };
  await asr.pushAudio(new Float32Array(16000), false);
  assert.equal(phrases.length, 0);
  await asr.pushAudio(new Float32Array(1001).fill(.1), true);
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].start, .8); // 200 ms pre-roll retains the onset
  assert.equal(asr.samples, 17001);
  assert.equal(asr.pending.length, 0);
  assert.equal(asr.segmentStart, null);
  asr.words = [{text:'old',time:0}]; asr.metrics.decoderCalls = 10;
  asr.startStream();
  assert.deepEqual(asr.words, []);
  assert.equal(asr.samples, 0);
  assert.equal(asr.metrics.decoderCalls, 0);
});

test('continuous audio closes bounded phrases without dropping input between arbitrary chunks', async () => {
  const { MoonshineBrowserASR } = await import('../src/browser/moonshine-streaming.js');
  const asr = new MoonshineBrowserASR();
  asr.config = { frontend_state_shapes: {} }; asr.startStream();
  const sizes = [];
  asr.update = async function(final) {
    if (final) { sizes.push(this.segmentSamples); this.clearSegment(); }
    else this.toEncode = new Float32Array();
  };
  const audio = new Float32Array(25 * 16000).fill(.05);
  for (let start=0; start<audio.length; start+=777) await asr.pushAudio(audio.subarray(start,start+777),false);
  await asr.pushAudio(new Float32Array(),true);
  assert.deepEqual(sizes,[12*16000,12*16000,16000]);
  assert.equal(asr.samples,audio.length);
});

test('EOS as the first token is a valid empty hypothesis during streaming and flush', async () => {
  const { MoonshineBrowserASR } = await import('../src/browser/moonshine-streaming.js');
  const { Tensor } = await import('onnxruntime-web/webgpu');
  const cache = () => new Tensor('float32', Float32Array.of(0), [1,1,1,1,1]);
  for (const final of [false, true]) {
    const asr = new MoonshineBrowserASR(); asr.startStream();
    asr.config = { decoder_dim:1, depth:1, nheads:1, head_dim:1, bos_id:1, eos_id:2, vocab_size:3 };
    asr.memory = Float32Array.of(0); asr.emitted = 1;
    asr.segmentStart = 1; asr.segmentSamples = 640; asr.lastSpeech = 640;
    const completed = {text:'Earlier.',time:.5,stable:true};
    asr.words = [completed, {text:'Provisional',time:1,stable:false}]; asr.completed = 1;
    asr.tokenizer = { decode() { throw Error('Empty tokens must not reach the tokenizer'); } };
    asr.sessions = {
      cross_kv: { async run() { return {k_cross:cache(),v_cross:cache()}; } },
      decoder_kv: { async run() { return {
        logits:new Tensor('float32',Float32Array.of(-10,-10,10),[1,1,3]),
        out_k_self:cache(),out_v_self:cache(),
      }; } },
    };
    await asr.decode(final);
    assert.deepEqual(asr.words,[completed]);
    assert.equal(asr.metrics.decoderCalls,1);
    assert.equal(asr.metrics.decoderLimitHits,0);
  }
});
