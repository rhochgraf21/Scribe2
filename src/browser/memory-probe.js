// Allocated WASM address space, not resident RAM or GPU memory. Weak references
// avoid keeping a runtime alive merely to measure it. Install before ORT loads.
const memories = new Set();
let supported = false;
try {
  const Original = WebAssembly.Memory;
  if (typeof WeakRef === 'function') {
    WebAssembly.Memory = new Proxy(Original, {
      construct(Target, args) {
        const memory = new Target(...args);
        memories.add(new WeakRef(memory));
        return memory;
      },
    });
    supported = true;
  }
} catch { /* Diagnostics must never prevent inference. */ }
export function wasmMemorySnapshot() {
  let bytes = 0, count = 0;
  for (const ref of memories) {
    const memory = ref.deref();
    if (!memory) { memories.delete(ref); continue; }
    bytes += memory.buffer.byteLength; count++;
  }
  return { wasmBytes: supported && count ? bytes : null, wasmMemories: count };
}
