export const LOG_KEY = 'scribe-diagnostic-current-v1';
export const PREVIOUS_KEY = 'scribe-diagnostic-previous-v1';
const MAX_POINTS = 960;
const MAX_BYTES = 256 * 1024;
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
      threadBudget:config.threadBudget,
    }, points:[], limitations:'WASM allocation is not resident RAM. GPU and total Safari memory are unavailable. Interrupted does not prove jetsam.' };
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
    // Keep the first checkpoint plus a rolling tail.
    while (this.current.points.length > MAX_POINTS) this.current.points.splice(1,1);
    let json = JSON.stringify(this.current);
    while (json.length > MAX_BYTES && this.current.points.length > 2) {
      this.current.points.splice(1,1); json = JSON.stringify(this.current);
    }
    try { this.storage.setItem(LOG_KEY, json); this.available = true; }
    catch { this.available = false; }
  }
  clear() {
    this.current = this.previous = null;
    try { this.storage.removeItem(LOG_KEY); this.storage.removeItem(PREVIOUS_KEY); this.available = true; }
    catch { this.available = false; }
  }
}
