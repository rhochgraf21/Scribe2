// Test-only measurement of WASM linear-memory allocation, not whole-browser RSS.
const OriginalMemory = WebAssembly.Memory;
const memories = [];
WebAssembly.Memory = new Proxy(OriginalMemory, {
 construct(Target, args) {
  const memory = new Target(...args);
  memories.push(new WeakRef(memory));
  return memory;
 },
});
setInterval(() => {
 const alive = memories.map(ref => ref.deref()).filter(Boolean);
 if (alive.length) postMessage({type:'wasm-memory',bytes:alive.reduce((n,memory)=>n+memory.buffer.byteLength,0)});
},100);
// Do not send a load message until the actual worker handler has been installed.
import('../src/browser/inference.worker.js').then(() => postMessage({type:'fixture-ready'}));
