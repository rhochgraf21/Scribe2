import test from 'node:test';
import assert from 'node:assert/strict';
import { captionDefaults, captionModelEntries } from '../src/browser/caption-options.js';
import { modelProfiles, validateModelFiles } from '../src/browser/model-import.js';
import { transcriptText } from '../src/browser/speaker-names.js';

test('phones start with Tiny, CPU and no speaker model; desktops retain full features', () => {
 for (const browser of [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, { userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile' }, { userAgentData: { mobile: true } }]) {
  assert.deepEqual(captionDefaults(browser), { phone: true, cpuMode: 'sequential', speakerDtype: 'q4', modelProfile: 'moonshine-tiny', speakerDetection: false, device: 'wasm' });
 }
 assert.deepEqual(captionDefaults({ userAgent: 'Mozilla/5.0 Macintosh' }), { phone: false, cpuMode: 'parallel', speakerDtype: 'q8', modelProfile: 'standard', speakerDetection: true, device: 'webgpu' });
});
test('speech-only requirements omit diarization for every model and reduce Tiny to about 78 MB', async () => {
 for (const profile of Object.values(modelProfiles)) {
  const speech = captionModelEntries(profile, false);
  assert.ok(speech.length); assert.ok(speech.every(file => !file.path.startsWith('diar/')));
  assert.ok(speech.length < profile.entries.length);
  assert.equal(captionModelEntries(profile, true), profile.entries);
 }
 const tiny = captionModelEntries(modelProfiles['moonshine-tiny'], false);
 const mb = tiny.reduce((total, file) => total + file.size, 0) / 1e6;
 assert.ok(mb > 70 && mb < 80);
 // Empty import correctly reports a speech file, not a skipped speaker file.
 await assert.rejects(validateModelFiles([], () => {}, tiny), /moonshine-tiny/);
});
test('speech-only export contains words without unidentified-speaker labels', () => {
 assert.equal(transcriptText({ segments: [{ speaker:null, text:'Hello' }, { speaker:null, text:'there' }] }, false), 'Hello there');
});

test('selected speaker precision replaces Q8 files and is still entirely optional', async () => {
 const { speakerModelProfiles } = await import('../src/browser/model-import.js');
 for (const profile of Object.values(modelProfiles)) {
  const selected = captionModelEntries(profile, true, speakerModelProfiles.q4f16.entries);
  assert.ok(selected.some(file => file.path === 'diar/onnx/model_q4f16.onnx'));
  assert.ok(selected.some(file => file.path === 'diar/onnx/model_q4f16.onnx_data'));
  assert.ok(!selected.some(file => file.path.includes('model_quantized')));
  assert.ok(captionModelEntries(profile, false, speakerModelProfiles.q4f16.entries).every(file => !file.path.startsWith('diar/')));
 }
 const chunks = (await import('../config/diar-q4f16-chunks.json', {with:{type:'json'}})).default;
 const files = speakerModelProfiles.q4f16.entries;
 assert.ok(files.reduce((n,f)=>n+f.size,0) < 74000000);
 for(const file of files.filter(f=>f.lfs)) {
  assert.equal(chunks.files[file.path].sha256,file.lfs.sha256);
  assert.equal(chunks.files[file.path].hashes.length,Math.ceil(file.size/chunks.blockSize));
 }
});

test('normal Q4 has pinned files, bounded verification and no unwanted Q8 weights', async () => {
 const { speakerModelProfiles } = await import('../src/browser/model-import.js');
 const chunks = (await import('../config/diar-q4-chunks.json', {with:{type:'json'}})).default;
 const entries = captionModelEntries(modelProfiles['moonshine-tiny'],true,speakerModelProfiles.q4.entries);
 assert.ok(entries.some(file=>file.path==='diar/onnx/model_q4.onnx'));
 assert.ok(entries.every(file=>!file.path.includes('model_quantized')&&!file.path.includes('model_q4f16')));
 assert.ok(speakerModelProfiles.q4.entries.reduce((n,f)=>n+f.size,0)<84000000);
 for(const file of speakerModelProfiles.q4.entries.filter(f=>f.lfs)) {
  assert.match(file.url,/\/resolve\/[0-9a-f]{40}\//);
  assert.equal(chunks.files[file.path].sha256,file.lfs.sha256);
  assert.equal(chunks.files[file.path].hashes.length,Math.ceil(file.size/chunks.blockSize));
 }
});
