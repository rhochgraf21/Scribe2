import { padWasm } from './pad-wasm.mjs';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const runtime = dirname(require.resolve('onnxruntime-web'));
const root = resolve('browser-dist');
await mkdir(`${root}/ort`, { recursive:true });
for (const name of await readdir(runtime)) {
  if (/^ort-wasm-simd-threaded(?:\.(?:jsep|asyncify|jspi))?\.(wasm|mjs)$/.test(name)) await cp(`${runtime}/${name}`, `${root}/ort/${name}`);
}
for (const name of ['pcm-worklet.js','audio.js','isolation-worker.js']) await cp(`public/${name}`, `${root}/${name}`);
await mkdir(`${root}/licenses`, { recursive:true });
await cp('src/browser/ASR-LICENSE', `${root}/licenses/asr-reference.txt`);
await cp('vendor/transformers/LICENSE', `${root}/licenses/transformers.txt`);
await cp('vendor/PROVENANCE.json', `${root}/licenses/provenance.json`);
await cp('config/cpu-model.json', `${root}/licenses/cpu-model-manifest.json`);
await cp('config/browser-models.json', `${root}/licenses/model-manifest.json`);
await writeFile(`${root}/index.html`, await readFile(`${root}/browser.html`));
await writeFile(`${root}/.nojekyll`, '');
console.log('Browser-only site built with small Silero VAD. Speech/speaker models remain separate; no audio or backend included.');

await cp('config/moonshine-models.json', `${root}/licenses/moonshine-model-manifest.json`);
await cp('src/browser/MOONSHINE-LICENSE', `${root}/licenses/moonshine.txt`);

await cp('config/diar-q4f16.json', `${root}/licenses/diar-q4f16-manifest.json`);
await cp('config/diar-q4.json', `${root}/licenses/diar-q4-manifest.json`);

// Keep the upstream binary alongside a separately named experimental artifact.
const originalWasm = await readFile(`${runtime}/ort-wasm-simd-threaded.asyncify.wasm`);
const padded = padWasm(originalWasm);
if (!WebAssembly.validate(padded.bytes)) throw Error('Padded runtime failed WASM validation');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await writeFile(`${root}/ort/ort-wasm-simd-threaded.asyncify.padded.wasm`, padded.bytes);
await writeFile(`${root}/ort/padding-manifest.json`, JSON.stringify({
  experimental:true, strategy:'skip-nops-before-function-end', minimum:padded.minimum,target:padded.target,
  original:{bytes:originalWasm.length,sha256:digest(originalWasm)},
  padded:{bytes:padded.bytes.length,sha256:digest(padded.bytes)}, functions:padded.changed,
},null,2));
console.log(`Experimental WASM: padded ${padded.changed.length} functions; added ${padded.bytes.length-originalWasm.length} bytes.`);
