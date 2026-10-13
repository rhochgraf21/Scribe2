import { DiagnosticRecorder } from './diagnostic-recorder';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Captions, Mic, Square, Pause, Play, Plus, Minus, ShieldCheck, Settings, X, Maximize, Minimize } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Diagnostics } from '@/components/Diagnostics';
import { Conversation } from '@/components/Conversation';
import { applyCaptionPatch } from './caption-updates';
import { validateModelFiles, downloadModels, MODEL_CACHE, modelProfiles, speakerModelProfiles } from './model-import';
import { openModelStore, deleteModelStore } from './model-storage';
import { renameSpeaker, transcriptText } from './speaker-names';
import { CaptionSetup } from './CaptionSetup';
import { TableMode } from './TableMode';
import { captionDefaults, captionModelEntries, speechOnlyDescription } from './caption-options';
import { InferenceClient } from './inference-client';

export default function BrowserApp() {
  const [wasmPadding] = useState(() => new URL(location.href).searchParams.get('wasm-padding') === '1');
  const [diarizationTest] = useState(() => new URL(location.href).searchParams.get('diarization-test') === '1');
  const [recorder] = useState(() => { let storage; try { storage = localStorage; } catch {} return new DiagnosticRecorder(storage); });
  const recordingState = useRef({});
  const settingsDialog = useRef();
  const openSettings = () => settingsDialog.current?.showModal();
  const [enteredConversation, setEnteredConversation] = useState(false);
  const [viewMode, setViewMode] = useState('flow');
  const [defaults] = useState(captionDefaults);
  const [speakerDtype, setSpeakerDtype] = useState(diarizationTest ? 'q4' : defaults.speakerDtype);
  const [speakerDetection, setSpeakerDetection] = useState(diarizationTest || defaults.speakerDetection);
  const [modelProfile, setModelProfile] = useState(defaults.modelProfile);
  const modelEntries = diarizationTest ? speakerModelProfiles.q4.entries : captionModelEntries(modelProfiles[modelProfile], speakerDetection, speakerModelProfiles[speakerDtype].entries);
  function changeSpeakerDetection(enabled) {
    setModelFiles(null); setSpeakerDetection(enabled);
    if (!enabled) { setViewMode('flow'); if (deviceMode === 'hybrid') setDeviceMode('wasm'); }
    else if (defaults.phone && navigator.gpu) { setDeviceMode('hybrid'); setCpuMode('sequential'); }
  }
  const modelDownloadMB = Math.ceil(modelEntries.reduce((sum, file) => sum + file.size, 0) / 1e6);
  const panel = useRef(), fullscreenButton = useRef();
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  function chooseMode(mode) {
    // Reveal the panel synchronously while this click still has user activation.
    flushSync(() => { setViewMode(speakerDetection ? mode : 'flow'); setEnteredConversation(true); });
    void toggleFullscreen();
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement === panel.current) { await document.exitFullscreen(); return; }
    if (expanded) { setExpanded(false); return; }
    if (panel.current?.requestFullscreen) {
      try { await panel.current.requestFullscreen(); return; } catch { /* Use a full-window view when browser fullscreen is unavailable. */ }
    }
    setExpanded(true);
  }
  useEffect(() => {
    const changed = () => {
      const active = document.fullscreenElement === panel.current;
      setFullscreen(active);
      if (!active) fullscreenButton.current?.focus();
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const outside = [...document.querySelectorAll('.app-header, .conversation-heading, .conversation-tools, .mode-switch, .caption-setup, .skip-link, .workspace > .notice-panel')];
    const prior = outside.map(node => node.inert);
    outside.forEach(node => { node.inert = true; });
    (panel.current?.querySelector('.table-focus-actions button') || fullscreenButton.current)?.focus();
    const keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
      if (event.key === 'Tab') {
        const controls = [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.body.style.overflow = before;
      outside.forEach((node, i) => { node.inert = prior[i]; });
      document.removeEventListener('keydown', keys);
      fullscreenButton.current?.focus();
    };
  }, [expanded]);
  const modelInput = useRef(), downloadController = useRef();
  const [downloading, setDownloading] = useState(false);
  const [modelFiles, setModelFiles] = useState(null);
  const [checking, setChecking] = useState(false);
  async function download() {
    const controller = new AbortController(); downloadController.current = controller;
    setChecking(true); setDownloading(true); setModelFiles(null); setError('');
    try {
      const result = await downloadModels(setStatus, { signal: controller.signal, entries: modelEntries });
      setModelFiles(result.files);
      setStatus(result.saved ? 'Models verified and saved on this device. Ready to load.' : 'Models verified. Ready to load; browser storage was unavailable or full.');
    } catch (error) {
      setStatus(controller.signal.aborted ? 'Download cancelled. Verified files remain saved for the next attempt.' : 'Download failed. Retry or import your model folder.');
      if (!controller.signal.aborted) setError(error.message);
    } finally { setChecking(false); setDownloading(false); downloadController.current = null; }
  }
  async function clearModelCache() {
    try { await deleteModelStore(); await caches.delete(MODEL_CACHE); setStatus('Saved model downloads removed.'); }
    catch (error) { setError(error.message); }
  }
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setChecking(true); setModelFiles(null); setError('');
    setStatus('Download or import the selected models to begin.');
    (async () => {
      try {
        const store = await openModelStore();
        const cache = await globalThis.caches?.open(MODEL_CACHE);
        const keys = new Set((await cache?.keys() || []).map(request => request.url));
        const available = await Promise.all(modelEntries.map(async entry => await store.has(entry) || keys.has(entry.url)));
        if (!available.every(Boolean)) {
          if (active && available.some(Boolean)) setStatus('Some model files are already saved. Download models will reuse them and finish the rest.');
          return;
        }
        const result = await downloadModels(message => { if (active) setStatus(message); }, {
          signal: controller.signal, store, entries: modelEntries,
          fetcher: () => { throw Error('Saved models need repair. Choose Download models or Import models.'); },
        });
        if (active) { setModelFiles(result.files); setStatus('Saved models verified. Ready to load.'); }
      } catch (error) { if (active) setStatus(error.message); }
      finally { if (active) setChecking(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [modelProfile, speakerDetection, speakerDtype]);
  async function importModels(event) {
    setChecking(true); setModelFiles(null); setError('');
    try { setModelFiles(await validateModelFiles([...event.target.files], setStatus, modelEntries)); setStatus('Models verified. Ready to load.'); }
    catch (error) { setError(error.message); setStatus('Import failed. Choose the approved model folder.'); }
    finally { setChecking(false); event.target.value = ''; }
  }
  const worker = useRef(), capture = useRef(), pending = useRef(0), liveRef = useRef(false);
  const [phase, setPhase] = useState('unloaded'), [status, setStatus] = useState('Download the approved models or import your model folder to begin.');
  const [error, setError] = useState(''), [devices, setDevices] = useState([]), [device, setDevice] = useState('');
  const [session, setSession] = useState({ id: 'browser', segments: [] }), [holding, setHolding] = useState(false), [held, setHeld] = useState(null);
  const [size, setSize] = useState(28), [contrast, setContrast] = useState(false), [announce, setAnnounce] = useState(false);
  const [level, setLevel] = useState(0), [lag, setLag] = useState(0), [speed, setSpeed] = useState(null);
  const [deviceMode, setDeviceMode] = useState(diarizationTest ? 'webgpu' : defaults.device);
  const executionLabel = diarizationTest ? 'WebGPU · Q4 diarization only' : `${deviceMode === 'hybrid' ? 'CPU speech + WebGPU speakers' : deviceMode === 'webgpu' ? 'WebGPU' : 'browser CPU'} · ${speakerDetection ? 'speech + speakers' : 'speech only'}`;
  const [diagnostics, setDiagnostics] = useState(null), [threadBudget, setThreadBudget] = useState(6);
  const lastDiagnostic = useRef(0);
  const [cpuMode, setCpuMode] = useState(defaults.cpuMode);
  const sizes = [20, 24, 28, 32, 40];
  recordingState.current = { phase, segmentCount:session.segments.length, transcriptCharacters:session.segments.reduce((n,s) => n + (s.text?.length || 0), 0), pendingSeconds:pending.current / 16000 };
  function checkpoint(event) { recorder.record(event, worker.current?.diagnostics(), recordingState.current); }
  useEffect(() => {
    const timer = setInterval(() => { if (['loading','starting','listening','stopping'].includes(recordingState.current.phase)) checkpoint('sample'); }, 25);
    const visibility = () => checkpoint(document.hidden ? 'hidden' : 'visible');
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [recorder]);
  const live = phase === 'listening';
  async function enumerate() {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter(d => d.kind === 'audioinput'));
  }
  function release() {
    liveRef.current = false;
    const current = capture.current; capture.current = null;
    current?.stream.getTracks().forEach(track => track.stop());
    current?.node?.disconnect(); current?.source?.disconnect(); current?.context.close().catch(() => {});
    setLevel(0);
  }
  function fail(message) {
    checkpoint('error');
    release(); worker.current?.terminate(); worker.current = null;
    pending.current = 0; setLag(0); setPhase('unloaded'); setError(message); setStatus('Stopped. Load models to try again.');
  }
  useEffect(() => {
    enumerate().catch(() => {});
    navigator.mediaDevices?.addEventListener('devicechange', enumerate);
    const cleanup = () => { checkpoint('pagehide'); downloadController.current?.abort(); release(); worker.current?.terminate(); };
    window.addEventListener('pagehide', cleanup);
    return () => { cleanup(); window.removeEventListener('pagehide', cleanup); navigator.mediaDevices?.removeEventListener('devicechange', enumerate); };
  }, []);
  function load() {
    recorder.begin({ wasmPadding, diarizationOnly:diarizationTest, browser:navigator.userAgent, modelProfile:diarizationTest ? 'none' : modelProfile, speakerDtype, speakerDetection, device:deviceMode, mode:cpuMode, threadBudget });
    setDiagnostics(null); setError(''); setPhase('loading'); setStatus(diarizationTest ? 'Loading Q4 only into browser memory…' : 'Loading models into browser memory…');
    worker.current?.terminate();
    let firstInference = true;
    const next = new InferenceClient({ diarizationOnly:diarizationTest, speakerDetection, mode:cpuMode, device:deviceMode, threadBudget:deviceMode !== 'webgpu' ? threadBudget : 4, jointMode:'logits' }); worker.current = next;
    next.onerror = event => fail(event.message || 'Browser inference worker failed');
    next.onmessage = ({ data }) => {
      if (data.type === 'runtime-info') recorder.runtime(data.runtime);
      if (data.type === 'diagnostic-fault') recorder.fault(data.fault);
      if (['status','ready','stopped','warning'].includes(data.type)) checkpoint(data.type);
      if (data.diagnostics && (data.type !== 'ack' || performance.now() - lastDiagnostic.current > 1000)) { setDiagnostics(data.diagnostics); lastDiagnostic.current = performance.now(); }
      if (data.type === 'status') setStatus(data.message);
      if (data.type === 'ready') { setPhase('ready'); if (data.plan.mode !== 'speech-only') setCpuMode(data.plan.mode); setStatus(`Ready · ${executionLabel} · ${data.plan.mode === 'diarization-only' ? 'one speaker worker' : data.plan.mode === 'speech-only' ? 'speech worker' : data.plan.mode === 'parallel' ? 'separate workers' : 'shared worker'}`); }
      if (data.type === 'error') fail(data.message);
      if (data.type === 'warning') setError(data.message);
      if (data.type === 'captions') {
        setSession(previous => applyCaptionPatch(previous, data));
      }
      if (data.type === 'ack') { if (firstInference) { checkpoint('first-inference'); firstInference = false; } setSpeed(data.elapsedMs && data.audioSeconds ? data.audioSeconds / (data.elapsedMs / 1000) : null); pending.current = Math.max(0, pending.current - data.samples); setLag(pending.current / 16000); }
      if (data.type === 'stopped') { setPhase('ready'); setStatus(`${diarizationTest ? 'Test stopped' : 'Conversation ended'} · ${executionLabel}`); }
    };
    next.postMessage({ type: 'load', wasmPadding, speakerDtype, modelProfile:diarizationTest ? 'standard' : modelProfile, modelFiles, assetBase: new URL('.', document.baseURI).href });
  }
  async function selectMicrophones() {
    try {
      setError(''); const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); await enumerate();
    } catch (e) { setError(e.message); }
  }
  async function start() {
    checkpoint('start');
    setPhase('starting'); setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: device ? { exact: device } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const context = new AudioContext();
      capture.current = { stream, context };
      await context.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href);
      const source = context.createMediaStreamSource(stream);
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 7200; filter.Q.value = 0.707;
      const node = new AudioWorkletNode(context, 'pcm-capture');
      const mute = context.createGain(); mute.gain.value = 0;
      Object.assign(capture.current, { source, node });
      source.connect(filter).connect(node).connect(mute).connect(context.destination);
      pending.current = 0; setLag(0); setSpeed(null); setDiagnostics(null); lastDiagnostic.current = 0; setSession({ id: crypto.randomUUID(), segments: [] }); setHolding(false); setHeld(null);
      worker.current.postMessage({ type: 'start' });
      liveRef.current = true;
      node.port.onmessage = ({ data }) => {
        if (!data.pcm || !liveRef.current) return;
        const pcm = new Int16Array(data.pcm), samples = Float32Array.from(pcm, x => x / 32768);
        const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
        setLevel(Math.min(5, Math.ceil(rms * 60)));
        pending.current += samples.length;
        setLag(pending.current / 16000);
        if (pending.current > 15 * 16000) { fail('This device cannot keep up. Captions stopped after 15 seconds of pending audio; the microphone is off and pending audio was discarded.'); return; }
        worker.current.postMessage({ type: 'audio', samples: samples.buffer }, [samples.buffer]);
      };
      await context.resume(); await enumerate();
      setPhase('listening'); setStatus(`Listening · ${executionLabel}`);
      if (!speakerDetection) { setViewMode('flow'); setEnteredConversation(true); setExpanded(true); }
    } catch (e) { checkpoint('error'); release(); setPhase('ready'); setError(e.message); }
  }
  async function stop() {
    checkpoint('stop-request');
    setPhase('stopping'); setStatus('Finishing pending captions…');
    const current = capture.current;
    if (current?.node) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 500);
        const receive = current.node.port.onmessage;
        current.node.port.onmessage = event => {
          receive(event);
          if (event.data.flushed) { clearTimeout(timeout); resolve(); }
        };
        current.node.port.postMessage('flush');
      });
    }
    release(); worker.current?.postMessage({ type: 'stop' });
  }
  function exportText() {
    const url = URL.createObjectURL(new Blob([transcriptText(session, speakerDetection)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'scribe-transcript.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const paddingUrl = new URL(location.href);
  if (wasmPadding) paddingUrl.searchParams.delete('wasm-padding');
  else paddingUrl.searchParams.set('wasm-padding', '1');
  const setupVisible = !enteredConversation || ['unloaded', 'loading'].includes(phase);
  const toggleHold = () => { if (!holding) setHeld(structuredClone(session)); setHolding(!holding); };
  return <div className={`app-shell ${setupVisible ? 'setup-active' : ''} ${contrast ? 'high-contrast' : ''}`}>
    <a hidden={setupVisible} className="skip-link" href="#transcript">Skip to conversation captions</a>
    <header className="app-header"><div className="brand"><span className="brand-symbol"><Captions aria-hidden="true"/></span><span>Scribe<a id="setup-wasm-padding" className="brand-subtitle setup-runtime-link" href={paddingUrl.href} title="Experimental Safari WASM padding; switching reloads the page">{wasmPadding ? 'Use original runtime' : 'Try Safari padding'}</a></span></div><div className="header-actions"><span className="local-badge"><ShieldCheck size={18} aria-hidden="true"/>On this device</span><Button variant="outline" onClick={openSettings}><Settings size={18}/>Settings</Button></div></header>
    <input ref={modelInput} id="model-folder" type="file" webkitdirectory="" multiple hidden disabled={phase !== 'unloaded' || checking} onChange={importModels}/>
    <main className={`workspace ${setupVisible ? 'setup-only' : ''}`}>
      <section hidden={setupVisible} className="conversation-heading" aria-label="Conversation controls"><div><p className="eyebrow">HERE, TOGETHER</p><h1>Stay in the conversation.</h1><p className="heading-description">One reading flow.{speakerDetection ? ' Voices marked in place.' : ' Live captions without speaker detection.'}</p></div><div className="session-controls">
        {!setupVisible && <Button id="record" className="listen-button" disabled={!['ready', 'listening'].includes(phase)} onClick={live ? stop : start}>{live ? <Square size={18}/> : <Mic size={18}/>}<span id="record-label">{live ? 'Stop captions' : phase === 'ready' ? 'Start captions' : 'Finishing…'}</span></Button>}
      </div></section>
      {error && <div className="notice-panel notice-error" role="alert"><p>{error}</p></div>}
      {lag > 2 && live && <div className="notice-panel" role="status"><p>Captions are {lag.toFixed(1)} seconds behind. This device is processing pending speech.</p></div>}
      {setupVisible && !diarizationTest && <CaptionSetup speakerDetection={speakerDetection} onSpeakerDetectionChange={changeSpeakerDetection} phone={defaults.phone} phase={phase} status={status} onLoad={load} onStart={start} onChooseMode={chooseMode} onStop={stop} onSettings={openSettings} tableMode={viewMode === 'table'} models={modelProfiles} modelProfile={modelProfile} onModelChange={value => { setModelFiles(null); setModelProfile(value); if (modelProfiles[value].cpuOnly && deviceMode === 'webgpu') setDeviceMode('wasm'); }} checking={checking} downloading={downloading} hasModels={Boolean(modelFiles)} modelLabel={modelProfiles[modelProfile].label} downloadMB={modelDownloadMB} onDownload={download} onImport={() => modelInput.current?.click()} onCancel={() => downloadController.current?.abort()}/> }
      {diarizationTest && <section className="caption-setup" aria-label="Diarization isolation test">
        <h1>Q4 diarization · WebGPU only</h1>
        <p>Only the speaker model loads. Tiny and other speech models are excluded. Speak normally while this runs; no captions will appear.</p>
        <p>Runtime: {wasmPadding ? 'padded Asyncify (experimental)' : 'original'}. Temporary history: 1.04 seconds. Diagnostic samples save every 25 ms.</p>
        <p role="status">{status}</p>
        <p>Audio processed: {(diagnostics?.workers?.[0]?.audioSeconds || 0).toFixed(1)} s · Speaker calls: {diagnostics?.workers?.[0]?.metrics?.speakerCalls || 0}</p>
        <div><Button disabled={phase !== 'unloaded' || checking || !!modelFiles} onClick={download}>Download Q4 ({modelDownloadMB} MB)</Button>{' '}
        <Button disabled={phase !== 'unloaded' || checking || !modelFiles} onClick={load}>Load Q4 only</Button>{' '}
        <Button disabled={!['ready','listening'].includes(phase)} onClick={live ? stop : start}>{live ? 'Stop test' : 'Start microphone test'}</Button>{' '}
        <Button variant="outline" onClick={openSettings}>Diagnostics / Settings</Button>{' '}
        <Button variant="ghost" onClick={() => { const url=new URL(location.href); url.searchParams.delete('diarization-test'); location.assign(url.href); }}>Exit test and reload</Button></div>
      </section>}
      <div className="conversation-stage" hidden={setupVisible}>
      {speakerDetection && <div className="mode-switch" role="group" aria-label="Conversation mode"><Button variant="ghost" aria-pressed={viewMode === 'flow'} onClick={() => setViewMode('flow')}>Reading mode</Button><Button variant="ghost" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}>Table mode</Button></div>}
      <div className="workspace-grid browser-workspace"><section ref={panel} className={`caption-panel ${viewMode === 'table' ? 'table-mode-panel' : ''} ${expanded ? 'conversation-expanded' : ''}`} aria-labelledby="caption-title" role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined}>
        <div className="caption-panel-header"><div className="caption-heading"><h2 id="caption-title">{viewMode === 'table' ? 'Table conversation' : 'Conversation'}</h2><span id="studio-status" className="listening-status" role="status">{status}</span></div><div className="conversation-view-actions">{(fullscreen || expanded) && live && <Button variant="outline" onClick={stop}><Square size={16}/>Stop captions</Button>}<Button ref={fullscreenButton} id="conversation-fullscreen" variant="outline" onClick={toggleFullscreen} aria-pressed={fullscreen || expanded} aria-label={fullscreen || expanded ? 'Exit fullscreen conversation' : 'Fullscreen conversation'}>{fullscreen || expanded ? <Minimize size={18} aria-hidden="true"/> : <Maximize size={18} aria-hidden="true"/>}{fullscreen || expanded ? 'Exit fullscreen' : 'Fullscreen'}</Button></div></div>{(fullscreen || expanded) && error && <div className="notice-panel notice-error" role="alert">{error}</div>}
        {(fullscreen || expanded) && lag > 2 && live && <div className="notice-panel" role="status">Captions are {lag.toFixed(1)} seconds behind.</div>}
        {viewMode === 'flow' && <div className="reading-toolbar"><div className="type-controls" role="group" aria-label="Caption text size"><Button variant="ghost" size="icon" aria-label="Decrease caption text size" disabled={size === 20} onClick={() => setSize(sizes[sizes.indexOf(size) - 1])}><Minus size={17}/></Button><span className="text-size-label">Aa {size}</span><Button variant="ghost" size="icon" aria-label="Increase caption text size" disabled={size === 40} onClick={() => setSize(sizes[sizes.indexOf(size) + 1])}><Plus size={17}/></Button></div><Button variant="outline" onClick={toggleHold} disabled={!session.segments.length} aria-pressed={holding}>{holding ? <Play size={16}/> : <Pause size={16}/>}{holding ? 'Resume text' : 'Hold text'}</Button></div>}
        {viewMode === 'table' && (fullscreen || expanded) && <div className="table-focus-actions" role="group" aria-label="Fullscreen controls">
          {live && <Button variant="outline" size="icon" aria-label="Stop captions" onClick={stop}><Square size={18}/></Button>}
          {holding && <Button variant="outline" onClick={() => setHolding(false)}><Play size={16}/>Resume text</Button>}
          <Button variant="outline" size="icon" aria-label="Exit fullscreen conversation" onClick={toggleFullscreen}><Minimize size={18}/></Button>
        </div>}
        <TableMode onRename={(id, name) => {
          setSession(previous => renameSpeaker(previous, id, name));
          setHeld(previous => previous ? renameSpeaker(previous, id, name) : previous);
        }} session={session} live={live} holding={holding} held={held} size={size} announce={announce} onReturn={() => setHolding(false)} active={!setupVisible && viewMode === 'table'}/>
        {viewMode === 'flow' && <Conversation showSpeakers={speakerDetection} session={session} live={live} holding={holding} heldSession={held} textSize={size} announce={announce} onReturn={() => setHolding(false)} onRename={(id, name) => {
          setSession(previous => renameSpeaker(previous, id, name));
          setHeld(previous => previous ? renameSpeaker(previous, id, name) : previous);
        }}/> }
        <div className="caption-footer"><span>{!speakerDetection ? speechOnlyDescription : <>{viewMode === 'table' ? 'Edit table to change names or voice matches. ' : 'Tap a speaker label to name them. '}Speaker labels may change. Overlapping speech and word boundaries can be uncertain.</>}</span></div>
      </section></div>
      </div>
      <dialog ref={settingsDialog} className="caption-settings" aria-labelledby="settings-title" onClick={event => { if (event.target === settingsDialog.current) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close(); } }}><div className="settings-heading"><h2 id="settings-title">Settings</h2><Button variant="ghost" size="icon" aria-label="Close settings" onClick={() => settingsDialog.current.close()}><X size={20}/></Button></div><aside className="conversation-tools" aria-label="Caption settings">
        <section hidden={diarizationTest} className="tool-section"><h2>Models on your device</h2><label><input type="checkbox" checked={speakerDetection} disabled={phase !== 'unloaded' || checking} onChange={event => changeSpeakerDetection(event.target.checked)}/> Identify speakers (diarization)</label>{!speakerDetection && <p className="input-description">{speechOnlyDescription}</p>}<label htmlFor="speaker-precision">Speaker model</label><select id="speaker-precision" data-slot="native-select" value={speakerDtype} disabled={!speakerDetection || phase !== 'unloaded' || checking} onChange={event => { setModelFiles(null); setSpeakerDtype(event.target.value); }}>{Object.entries(speakerModelProfiles).map(([id, profile]) => <option key={id} value={id}>{profile.label}</option>)}</select><p className="input-description">Phones default to Q4 when speaker detection is enabled; other devices default to 8-bit. Q4 / FP16 has a smaller download but may use more runtime memory. Choose 8-bit for the original model.</p><label htmlFor="speech-model">Speech model</label><select id="speech-model" data-slot="native-select" value={modelProfile} disabled={phase !== 'unloaded' || checking} onChange={event => { setModelFiles(null); setModelProfile(event.target.value); if (modelProfiles[event.target.value].cpuOnly && deviceMode === 'webgpu') setDeviceMode('wasm'); }}>{Object.entries(modelProfiles).map(([id, profile]) => <option key={id} value={id}>{profile.label}</option>)}</select><p id="model-help" className="input-description">Download about {modelDownloadMB} MB from Hugging Face, or import your browser-models folder containing {`${modelProfiles[modelProfile].directory}/${speakerDetection ? ' and diar/' : ''}`}. Both options verify the approved model files. Audio stays here.</p><Button id="download-models" disabled={phase !== 'unloaded' || checking} aria-describedby="model-help" onClick={download}>Download models</Button>{' '}<Button id="import-models" variant="outline" disabled={phase !== 'unloaded' || checking} aria-describedby="model-help" onClick={() => modelInput.current?.click()}>Import models</Button>{downloading && <Button variant="outline" onClick={() => downloadController.current?.abort()}>Cancel download</Button>}<p className="input-description">Downloads are saved in this browser when storage permits. After refreshing, completed downloads are restored and verified automatically. Partial downloads resume file by file with Download models. Imports are not saved. The model host receives download requests; no files or audio are uploaded.</p><Button variant="ghost" disabled={checking} onClick={clearModelCache}>Delete saved models</Button></section><section className="tool-section"><div className="tool-heading"><Mic size={18}/><h2>Your microphone</h2></div><label htmlFor="microphone">Audio input</label><select id="microphone" data-slot="native-select" value={device} disabled={['listening', 'starting', 'stopping'].includes(phase)} onChange={e => setDevice(e.target.value)}><option value="">System default</option>{devices.filter(d => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select><p className="input-description">Choose the microphone closest to the conversation. Stop captions before switching.</p><Button variant="outline" disabled={live} onClick={selectMicrophones}>Show microphone names</Button><div className="signal-line"><span className={`signal-bars level-${level}`} aria-hidden="true">{[1,2,3,4,5].map(n => <i key={n}/>)}</span><span>{live ? level ? 'Audio detected' : 'No microphone signal' : 'Microphone off'}</span></div></section>
        <section className="tool-section"><h2 className="tool-heading">Reading comfort</h2><Button variant="outline" disabled={!session.segments.length} onClick={exportText}>Export text</Button><Button variant="outline" aria-pressed={contrast} onClick={() => setContrast(!contrast)}>High contrast</Button><p><label><input type="checkbox" checked={announce} onChange={e => setAnnounce(e.target.checked)}/> Announce captions to screen readers</label></p><Button variant="ghost" disabled={phase !== 'ready' && phase !== 'unloaded'} onClick={() => { setSession({ id: crypto.randomUUID(), segments: [] }); setHeld(null); setHolding(false); }}>Clear conversation</Button></section>
        <section className="privacy-card"><ShieldCheck size={20} aria-hidden="true"/><div><h2>Audio stays in this browser</h2><p>No inference server, recording, or audio uploads. Refresh clears the conversation. Models are imported or downloaded on request; app code loads from this website. Only model files may be saved, never conversations.</p></div></section>
        <section hidden={diarizationTest} className="tool-section"><label htmlFor="execution-device">Processing</label><select id="execution-device" data-slot="native-select" value={deviceMode} disabled={phase !== 'unloaded'} onChange={event => setDeviceMode(event.target.value)}><option value="hybrid" disabled={!speakerDetection}>CPU speech + WebGPU speakers (shared worker)</option><option value="webgpu" disabled={modelProfiles[modelProfile].cpuOnly}>WebGPU speech + speakers</option><option value="wasm">CPU only</option></select><p className="input-description">{!speakerDetection ? 'Only speech recognition is loaded. Speaker detection is off.' : deviceMode === 'hybrid' ? 'Speech uses the CPU and speaker detection uses WebGPU in one shared worker. Requires hardware WebGPU; choose CPU only if unavailable.' : deviceMode === 'webgpu' ? 'Speech and speaker detection use the GPU; token decoding uses the CPU.' : 'Speech and speaker detection use the CPU. Phone speed and memory use are not yet validated.'} CPU uses one thread without cross-origin isolation.</p><label htmlFor="cpu-mode">Worker scheduling</label><select id="cpu-mode" data-slot="native-select" value={deviceMode === 'hybrid' ? 'sequential' : deviceMode === 'webgpu' ? 'parallel' : cpuMode} disabled={!speakerDetection || phase !== 'unloaded' || deviceMode !== 'wasm'} onChange={event => setCpuMode(event.target.value)}><option value="sequential">Shared worker</option><option value="parallel">Separate workers (experimental)</option></select><p className="input-description">{speakerDetection ? 'Mixed CPU/WebGPU uses one shared worker. All-WebGPU uses separate workers. CPU-only scheduling can be chosen before loading models.' : 'Speech-only captions use one speech worker. Refresh to change speaker detection after loading.'}</p></section>
        {!diarizationTest && <section className="tool-section"><h2>WebGPU crash isolation</h2><p>Reload into a Q4-only microphone test. No speech model is loaded. Download the current diagnostic run first if you need it.</p><Button id="diarization-only-test" variant="outline" onClick={() => { const url=new URL(location.href); url.searchParams.set('diarization-test','1'); location.assign(url.href); }}>Test Q4 alone on WebGPU</Button></section>}
        <section className="tool-section"><h2>Safari compiler experiment</h2><p>Runtime: <strong>{wasmPadding ? 'Padded Asyncify (experimental)' : 'Original'}</strong>. Padding aims to keep selected large functions out of Safari’s optimizing compiler. It may reduce CPU speed and has not been validated on your iPhone.</p><Button id="toggle-wasm-padding" variant="outline" onClick={() => { const url=new URL(location.href); if(wasmPadding) url.searchParams.delete('wasm-padding'); else url.searchParams.set('wasm-padding','1'); location.assign(url.href); }}>{wasmPadding ? 'Use original runtime and reload' : 'Use padded runtime and reload'}</Button><p>Reloading stops the current session. Then load models and start the same test again. The selected runtime is included in diagnostic downloads.</p></section>
        <Diagnostics recorder={recorder} speakerDetection={speakerDetection} snapshot={diagnostics} modelProfile={modelProfile} device={deviceMode} threadBudget={threadBudget} onThreadBudget={setThreadBudget} unloaded={phase === 'unloaded'}/>
        <p className="small-note">Experimental · English captions · {modelProfiles[modelProfile].label}{speakerDetection ? ` + diarization ${speakerDtype}.` : ' · speech only.'} Processing speed depends on the device. {speed !== null && <span id="cpu-speed">Processing: {speed.toFixed(2)}× real time (1× keeps pace).</span>}</p>
      </aside></dialog>
    </main>
  </div>;
}
