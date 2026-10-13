export const DIAGNOSTIC_INTERVAL_MS = 10_000;
export const LOG_KEY = 'scribe-diagnostic-current-v1';
export const PREVIOUS_KEY = 'scribe-diagnostic-previous-v1';
const MAX_POINTS = 960;
const MAX_BYTES = 4 * 1024 * 1024; // Reject unexpectedly large stored reports on read.
// Explicit whitelist: never persist arbitrary events, captions, names or errors.
const numeric = object => Object.fromEntries(Object.entries(object || {}).filter(([,v]) => typeof v === 'number' && Number.isFinite(v)));
export class DiagnosticRecorder {
  constructor(storage, now = Date.now) {
    this.storage = storage; this.now = now; this.current = null; this.available = true;
    this.previous = this.read(LOG_KEY) || this.read(PREVIOUS_KEY);
  }
  read(key) {
    try {
      const raw = this.storage?.getItem(key);
      if (!raw || raw.length > MAX_BYTES) return null;
      const value = JSON.parse(raw);
      return value.version === 1 && Array.isArray(value.points) ? value : null;
    } catch { this.available = false; return null; }
  }
  begin(config) {
    if (this.current) this.previous = this.current;
    try { if (this.previous) this.storage.setItem(PREVIOUS_KEY, JSON.stringify(this.previous)); }
    catch { this.available = false; }
    this.current = { version:1, startedAt:this.now(), state:'loading', config:{
      modelProfile:config.modelProfile, speakerDtype:config.speakerDtype,
      speakerDetection:config.speakerDetection, device:config.device, mode:config.mode,
      threadBudget:config.threadBudget, wasmPadding:!!config.wasmPadding, diarizationOnly:!!config.diarizationOnly, browser:config.browser,
    }, sampleIntervalMs:DIAGNOSTIC_INTERVAL_MS, maxPoints:MAX_POINTS, points:[], faults:[], runtimes:[], limitations:'WASM allocation is not resident RAM. GPU and total Safari memory are unavailable. Interrupted does not prove jetsam.' };
    this.record('load');
  }
  record(event, snapshot = {}, counts = {}) {
    if (!this.current) return;
    if (event === 'start') this.current.state = 'running';
    if (event === 'ready' || event === 'stopped') this.current.state = 'ready';
    if (event === 'error') this.current.state = 'error';
    if (event === 'pagehide') this.current.state = 'page-hidden';
    const point = { at:this.now(), event, ...numeric(counts), capturedSeconds:snapshot.capturedSeconds,
      workers:(snapshot.workers || []).map(w => ({ role:w.role, ...numeric(w),
        speechDevice:w.speechDevice, speakerDevice:w.speakerDevice,
        memory:{ ...numeric(w.memory), stage:w.memory?.stage }, metrics:numeric(w.metrics) })) };
    this.current.points.push(point);
    // Retain exactly the latest entries; run metadata survives outside the ring.
    if (this.current.points.length > MAX_POINTS) this.current.points.splice(0, this.current.points.length - MAX_POINTS);
    const json = JSON.stringify(this.current);
    try { this.storage.setItem(LOG_KEY, json); this.available = true; }
    catch { this.available = false; }
  }
  runtime(runtime) {
    if (!this.current) return;
    const info = Object.fromEntries(['version','variant','configuredWasm','configuredMjs','requestedWasm','browser'].filter(k=>typeof runtime[k] === 'string').map(k=>[k,runtime[k].slice(0,300)]));
    info.jspiSupported = !!runtime.jspiSupported;
    const index = this.current.runtimes.findIndex(r=>r.configuredWasm === info.configuredWasm);
    if (index >= 0) this.current.runtimes[index] = info; else if (this.current.runtimes.length < 4) this.current.runtimes.push(info);
    this.record('runtime-info');
  }
  fault(fault) {
    if (!this.current || !['gpu-uncaptured','gpu-device-lost','gpu-device-request','gpu-observer-ready','gpu-observer-unavailable','inference-error'].includes(fault?.kind)) return;
    const clean = value => typeof value === 'string' ? value.replace(/(?:https?:|blob:|file:)[^\s]+/g, '[URL]').slice(0,1500) : undefined;
    this.current.faults.push({at:this.now(),kind:fault.kind,name:clean(fault.name),reason:clean(fault.reason),message:clean(fault.message),stage:clean(fault.stage)});
    if (this.current.faults.length > 32) this.current.faults.shift();
    this.record('diagnostic-fault'); // Persist immediately, before a fatal error terminates the worker.
  }
  clear() {
    this.current = this.previous = null;
    try { this.storage.removeItem(LOG_KEY); this.storage.removeItem(PREVIOUS_KEY); this.available = true; }
    catch { this.available = false; }
  }
}
