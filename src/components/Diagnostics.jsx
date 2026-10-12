import { Button } from './ui/button';
const stages = [['featuresMs','Speech preparation'],['encoderMs','Speech encoder'],['decoderMs','Speech decoder'],['jointMs','Token scoring'],['selectMs','Token selection'],['speakerFeaturesMs','Speaker preparation'],['speakerMs','Speaker detection (total)'],['speakerInferenceMs','Model computation'],['speakerCacheMs','Speaker cache updates'],['speakerTensorMs','Tensor preparation / output']];
const number = value => Number.isFinite(value) ? value.toFixed(1) : '—';
export function Diagnostics({ snapshot, modelProfile, device, threadBudget, onThreadBudget, unloaded }) {
  const workers = snapshot?.workers || [];
  function download() {
    const report = { version:1, createdAt:new Date().toISOString(), modelProfile, device,
      browser:navigator.userAgent, ...snapshot };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download='scribe-diagnostics.json'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <details className="tool-section diagnostics"><summary>Performance diagnostics</summary>
    <p className="input-description">Measurements stay on this device. The report contains timings and browser details, without audio or captions.</p>
    <label htmlFor="thread-budget">CPU thread budget (reload models to change)</label>
    <select id="thread-budget" data-slot="native-select" value={threadBudget} disabled={!unloaded || device !== 'wasm'} onChange={e=>onThreadBudget(Number(e.target.value))}>
      {[1,2,4,6,8].map(n=><option key={n} value={n}>{n} thread{n===1?'':'s'}</option>)}
    </select>
    <p className="input-description">{globalThis.crossOriginIsolated ? 'Multithreading available.' : 'This page is limited to one WASM thread.'} Browser reports {navigator.hardwareConcurrency || 'unknown'} logical cores. With separate CPU workers, the 6-thread setting uses 2 for speech and 4 for speakers when enough cores are available. More threads may be slower.</p>
    {!workers.length ? <p>Load models and start captions to collect timings.</p> : <>
      <p>Audio received: {number(snapshot.capturedSeconds)} s · {snapshot.plan.mode === 'parallel' ? 'Separate workers' : 'Shared worker'}</p>
      {workers.map(worker=><div key={worker.role} className="diagnostic-worker">
        <strong>{worker.role === 'both' ? 'Speech + speakers' : worker.role === 'asr' ? 'Speech' : 'Speakers'}{worker.disabled ? ' (stopped)' : ''}</strong>
        <p>{worker.threads ?? '—'} configured thread(s) · Load: {number(worker.loadMs/1000)} s<br/>
        Pending audio: {number(worker.queuedSeconds)} s · Compute capacity: {number(worker.computeMs ? worker.audioSeconds*1000/worker.computeMs : NaN)}×</p>
        {!!worker.speakerChunkFrames && <p className="input-description">Speaker chunk: {worker.speakerChunkFrames * 80} ms · Lookahead: {worker.speakerLookaheadFrames * 80} ms · Recent history: {number(worker.speakerHistoryFrames * .08)} s · Calls: {worker.metrics.speakerCalls || 0}</p>}
        {worker.speakerRuntimeOptions && <p className="input-description">ONNX memory arena: {worker.speakerRuntimeOptions.enableCpuMemArena ? 'on' : 'off'} · Memory patterns: {worker.speakerRuntimeOptions.enableMemPattern ? 'on' : 'off'}</p>}
        <table><thead><tr><th>Stage</th><th>ms / audio second</th></tr></thead><tbody>
          {stages.filter(([key])=>key in worker.metrics).map(([key,label])=><tr key={key}><td>{label}</td><td>{number(worker.audioSeconds ? worker.metrics[key]/worker.audioSeconds : NaN)}</td></tr>)}
        </tbody></table>
        {!!worker.metrics.encoderCalls && <p className="input-description">Encoder calls: {worker.metrics.encoderCalls} · First: {number(worker.metrics.firstEncoderMs)} ms · Slowest: {number(worker.metrics.maxEncoderMs)} ms · Decoder calls: {worker.metrics.decoderCalls}</p>}
      </div>)}
      <p className="input-description">Model computation, cache updates, and tensor preparation / output are parts of speaker detection, not additional costs. Capacity above 1× keeps pace. Timings are session averages, include warm-up, and exclude model loading. Separate workers overlap. Pending audio excludes the model’s internal lookahead. Total process memory is not available through these diagnostics.</p>
    </>}
    <Button variant="outline" disabled={!snapshot} onClick={download}>Download diagnostics</Button>
  </details>;
}
