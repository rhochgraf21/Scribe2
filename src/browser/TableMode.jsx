import { useEffect, useRef, useState } from 'react';
import { Bell, Check, ChevronRight, Grip, Minus, Plus, UserRound, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Conversation, SpeakerLabel } from '@/components/Conversation';
import { captionGroups, bindSeat, filterSession, makeSeats, tableMentionAlerts, namedSession, resizeSeats, freshVoiceCandidate, nameTableSpeaker } from './table-mode';
import './table-mode.css';

export function TableMode({ session, live, holding, held, size, announce, onReturn, active, onRename }) {
  const [seats, setSeats] = useState(() => makeSeats());
  const [stage, setStage] = useState('setup'), [editing, setEditing] = useState(null);
  const [setupChoice, setSetupChoice] = useState(false);
  const [transcriptNaming, setTranscriptNaming] = useState(false);
  const [guided, setGuided] = useState(false), [sampling, setSampling] = useState(false);
  const [name, setName] = useState(''), [candidate, setCandidate] = useState('');
  const [selected, setSelected] = useState([]), [aliases, setAliases] = useState('');
  const [dismissed, setDismissed] = useState([]), [peek, setPeek] = useState(null);
  const nextSeatId = useRef(5);
  const [ownVoiceHistory, setOwnVoiceHistory] = useState([]);
  const [latestSpeaker, setLatestSpeaker] = useState(null);
  const baseline = useRef(new Map()), lastSignature = useRef(''), speakingTimer = useRef(), pressTimer = useRef(), longPressed = useRef(false), drag = useRef(null), table = useRef(null);
  useEffect(() => {
    setSeats(previous => previous.map(s => ({ ...s, speaker: null })));
    clearTimeout(speakingTimer.current);
    setOwnVoiceHistory([]); setSampling(false); setCandidate(''); setDismissed([]); setPeek(null); setLatestSpeaker(null);
    baseline.current = new Map(); lastSignature.current = '';
  }, [session.id]);
  useEffect(() => {
    const last = session.segments.filter(s => s.speaker).at(-1);
    const signature = last ? `${last.id}:${last.speaker}:${last.text}` : '';
    if (!last || signature === lastSignature.current) return;
    lastSignature.current = signature;
    setLatestSpeaker(String(last.speaker));
    clearTimeout(speakingTimer.current);
    speakingTimer.current = setTimeout(() => setLatestSpeaker(null), 3000);
  }, [session.segments]);
  useEffect(() => {
    if (!active || !live || !editing || !sampling) return;
    setCandidate(freshVoiceCandidate(session.segments, baseline.current));
  }, [session.segments, editing, candidate, active, live, sampling]);
  useEffect(() => () => { clearTimeout(speakingTimer.current); clearTimeout(pressTimer.current); }, []);
  const followed = new Set(seats.filter(s => selected.includes(s.id) && s.speaker).map(s => String(s.speaker)));
  const names = selected.map(id => seats.find(s => s.id === id)).filter(Boolean).map(s => s.name || (s.self ? 'You' : `Seat ${s.id}`));
  const named = namedSession(session, seats);
  const filtered = selected.length ? filterSession(named, followed) : named;
  const speakerStyles = Object.fromEntries(seats.filter(s => s.speaker).map(s => [s.speaker, { '--voice': `var(--table-voice-${seats.indexOf(s) % 4})` }]));
  const alerts = tableMentionAlerts(named, aliases, seats, followed, ownVoiceHistory).filter(a => !dismissed.includes(a.key));
  const other = selected.length ? (holding && held ? held : session).segments.filter(s => !followed.has(String(s.speaker))) : [];
  function renameCaptionSpeaker(id, value) {
    const next = nameTableSpeaker(seats, id, value, ownVoiceHistory);
    setSeats(next);
    const own = next.find(s => s.self && String(s.speaker) === String(id));
    if (own) {
      setAliases([own.name, ...aliases.split(',').slice(1).map(n => n.trim()).filter(Boolean)].join(', '));
      setOwnVoiceHistory(ids => [...new Set([...ids, String(id)])]);
    }
    onRename?.(id, value);
  }
  function updateAlertNames(value) {
    setAliases(value);
    const ownName = value.split(',')[0].trim();
    setSeats(previous => previous.map(s => s.self ? { ...s, name: ownName } : s));
  }
  function sample() { setSampling(true); baseline.current = new Map(session.segments.map(s => [s.id, `${s.speaker}:${s.text}`])); setCandidate(''); }
  function edit(seat) { setEditing(seat.id); setName(seat.name); setSampling(guided); baseline.current = new Map(session.segments.map(s => [s.id, `${s.speaker}:${s.text}`])); setCandidate(''); }
  function savePerson(match = true) {
    if (!seats.some(s => s.id === editing) || !name.trim() || (match && voiceConflict)) return;
    if (match && candidate && seats.find(s => s.id === editing)?.self) setOwnVoiceHistory(ids => [...new Set([...ids, candidate])]);
    if (match && candidate) setSeats(previous => bindSeat(previous, editing, candidate, name));
    else setSeats(previous => previous.map(s => s.id === editing ? { ...s, name: name.trim() } : s));
    const current = seats.find(s => s.id === editing);
    if (current?.self) setAliases([name.trim(), ...aliases.split(',').slice(1).map(value => value.trim()).filter(Boolean)].join(', '));
    const next = seats[seats.findIndex(s => s.id === editing) + 1];
    if (guided && next) edit(next);
    else {
      const unfinished = seats.find(s => s.id !== editing && !s.name.trim());
      if (guided && unfinished) { edit(unfinished); return; }
      setEditing(null); setSampling(false); setCandidate('');
      if (guided || !unfinished) { setGuided(false); setStage('conversation'); }
    }
  }
  useEffect(() => { drag.current = null; longPressed.current = false; }, [stage]);
  function count(delta) {
    const next = resizeSeats(seats, seats.length + delta, nextSeatId.current);
    if (next === seats) return;
    nextSeatId.current = Math.max(nextSeatId.current, ...next.map(s => s.id + 1));
    setSeats(next);
    setSelected(ids => ids.filter(id => next.some(s => s.id === id)));
    setCandidate(''); setSampling(false); cancelPress(); drag.current = null;
    if (editing && !next.some(s => s.id === editing)) {
      if (guided) edit(next.at(-1));
      else { setEditing(null); setGuided(false); }
    }
    if (peek && !next.some(s => String(s.speaker) === String(peek.speaker))) setPeek(null);
  }
  function showPeek(value) { setPeek(value); requestAnimationFrame(() => document.querySelector('.table-peek button')?.focus({ preventScroll: true })); }
  function recent(seat) { if (seat.speaker) showPeek({ speaker: seat.speaker }); }
  function cancelPress() { clearTimeout(pressTimer.current); }
  function move(event) {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    const bounds = table.current.getBoundingClientRect();
    if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) < 5 && !drag.current.moved) return;
    drag.current.moved = true;
    const x = Math.max(15, Math.min(85, (event.clientX - bounds.left) / bounds.width * 100));
    const y = Math.max(16, Math.min(84, (event.clientY - bounds.top) / bounds.height * 100));
    setSeats(previous => previous.map(s => s.id === drag.current.id ? { ...s, x, y } : s));
  }
  function toggle(id) { setSelected(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]); }
  const seat = seats.find(s => s.id === editing);
  const assignedSeat = seats.find(s => s.id !== editing && s.speaker === candidate);
  const ownVoiceConflict = Boolean(candidate && !seat?.self && ownVoiceHistory.includes(candidate));
  const voiceConflict = Boolean(candidate && (ownVoiceConflict || assignedSeat));
  const detectedVoices = [...new Set(session.segments.filter(s => s.speaker).map(s => String(s.speaker)))];
  const unmatchedVoices = detectedVoices.filter(id => !seats.some(s => s.speaker === id));
  return <div className={`table-mode ${stage === 'conversation' ? 'table-conversation' : ''}`} hidden={!active}>
    <div className="table-intro" id={stage === 'setup' && active ? 'transcript' : undefined} tabIndex={-1}><div><p className="eyebrow">{stage === 'setup' ? '01 / MAKE ROOM' : '02 / YOUR CONVERSATION'}</p><h2>{stage === 'setup' ? 'Set up your table' : 'Stay connected to the room.'}</h2><p>{stage === 'setup' ? 'Arrange the seats. Put a name to each voice.' : 'Tap the people you want to follow. Seats stay where you put them.'}</p></div>{stage === 'setup' ? <div className="seat-counter"><Button variant="ghost" size="icon" aria-label="Remove a seat" disabled={seats.length <= 2} onClick={() => count(-1)}><Minus size={18}/></Button><strong>{seats.length} people</strong><Button variant="ghost" size="icon" aria-label="Add a seat" disabled={seats.length >= 8} onClick={() => count(1)}><Plus size={18}/></Button></div> : <Button variant="outline" onClick={() => { setStage('setup'); setSetupChoice(true); setPeek(null); }}>Edit people & seats</Button>}</div>
    <div className="table-layout">
      <div className={`table-diagram ${alerts.length || peek ? 'has-notification' : ''}`}>
      <div className={`table-map ${seats.length > 6 ? 'crowded' : ''}`} ref={table} aria-label="Seating arrangement">
        <div className="table-top"><span>{stage === 'setup' ? 'A place for everyone' : 'Here, together'}</span></div>
        {seats.map((s, i) => <button key={s.id} className={`table-seat ${editing === s.id ? 'editing-seat' : ''} seat-color-${i % 4} ${s.self ? 'self-seat' : ''} ${selected.includes(s.id) && stage !== 'setup' ? 'selected' : ''} ${live && latestSpeaker === s.speaker ? 'speaking' : ''} ${alerts.some(a => String(a.speaker) === s.speaker) ? 'mentioned-you' : ''}`} style={{ left: `clamp(var(--seat-clearance, 80px), ${s.x}%, calc(100% - var(--seat-clearance, 80px)))`, top: `${s.y}%` }} aria-current={editing === s.id ? 'true' : undefined} aria-label={`${editing === s.id ? 'Editing: ' : ''}${s.name || (s.self ? 'You' : `Seat ${s.id}`)}${s.speaker ? ', voice matched' : ', voice not matched'}${live && latestSpeaker === s.speaker ? ', speaking recently' : ''}`} aria-pressed={stage !== 'setup' ? selected.includes(s.id) : undefined}
          onPointerDown={event => { longPressed.current = false; cancelPress(); if (stage === 'conversation' && s.speaker) pressTimer.current = setTimeout(() => { longPressed.current = true; recent(s); }, 550); if (stage === 'setup') { drag.current = { id: s.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={event => { if (stage === 'setup') move(event); else cancelPress(); }} onPointerUp={cancelPress} onPointerLeave={cancelPress} onPointerCancel={() => { cancelPress(); drag.current = null; }} onContextMenu={event => { if (stage === 'conversation' && s.speaker) { event.preventDefault(); recent(s); } }}
          onClick={event => { if (event.detail === 0) longPressed.current = false; if (longPressed.current) { longPressed.current = false; return; } if (drag.current?.moved) { drag.current = null; return; } drag.current = null; if (stage === 'setup') { edit(s); } else toggle(s.id); }}
          onKeyDown={event => { if (stage === 'conversation' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); recent(s); return; } if (stage !== 'setup' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); setSeats(previous => previous.map(item => item.id === s.id ? { ...item, x: Math.max(15, Math.min(85, item.x + (event.key === 'ArrowRight' ? 3 : event.key === 'ArrowLeft' ? -3 : 0))), y: Math.max(16, Math.min(84, item.y + (event.key === 'ArrowDown' ? 3 : event.key === 'ArrowUp' ? -3 : 0))) } : item)); }}>
          {editing === s.id && <span className="seat-editing-marker">Editing</span>}{alerts.some(a => String(a.speaker) === s.speaker) && <Bell className="seat-mention-badge" size={17} aria-label="Mentioned you"/>}<span className="seat-person">{selected.includes(s.id) && stage !== 'setup' ? <Check size={20}/> : <UserRound size={20}/>}</span><span>{s.name || (s.self ? 'You' : `Seat ${s.id}`)}<small>{stage === 'setup' ? s.speaker ? 'Voice matched' : 'Tap to name' : live && latestSpeaker === s.speaker ? 'Spoke recently' : s.speaker ? selected.includes(s.id) ? 'Following' : 'Tap to follow' : selected.includes(s.id) ? 'Selected · match voice' : 'Tap to follow'}</small></span>{stage === 'setup' && <Grip className="seat-grip" size={14}/>}
        </button>)}
      </div>
      {stage === 'conversation' && active && <>      <aside className="table-notifications" aria-label="Mention alerts and recent words">
      <div className="mention-alerts" aria-live={active ? 'polite' : 'off'}>{alerts.slice(-1).map(alert => <article className="mention-card" key={alert.key}><div className="table-row"><Bell size={20}/><strong>{named.speakers?.[alert.speaker] || (alert.speaker ? `Speaker ${alert.speaker}` : 'Someone')} mentioned you</strong></div><p>“{alert.text}”</p><div className="table-row"><Button variant="secondary" onClick={() => showPeek(alert)}>Peek</Button><Button variant="outline" onClick={() => { setDismissed(ids => [...ids, alert.key]); if (peek?.key === alert.key) setPeek(null); }}>Dismiss</Button></div></article>)}</div>
      {peek && <div className="table-peek"><div className="table-row"><h3>{named.speakers?.[peek.speaker] || `Speaker ${peek.speaker}`} · Recent words</h3><Button variant="ghost" onClick={() => setPeek(null)}>Close peek</Button></div><p>{session.segments.filter(s => String(s.speaker) === String(peek.speaker)).slice(-60).map(s => s.text).join(' ') || 'No recent words yet.'}</p><p className="table-fine">Your selection stays {names.join(' + ') || 'everyone'}.</p></div>}
      </aside>
</>}
      </div>
      {seat ? <form className="seat-editor" aria-labelledby="seat-editor-title" onSubmit={event => { event.preventDefault(); savePerson(); }}>
        {guided && <><p className="eyebrow">PERSON {seats.findIndex(s => s.id === editing) + 1} OF {seats.length}</p><progress aria-label="People named" value={seats.findIndex(s => s.id === editing)} max={seats.length}/></>}
        <div className="table-row"><h3 id="seat-editor-title">{seat.self ? 'Your seat' : seat.name ? `Edit ${seat.name} · Seat ${seat.id}` : `Who is in Seat ${seat.id}?`}</h3><Button type="button" variant="ghost" size="icon" aria-label="Close seat editor" onClick={() => { setEditing(null); setGuided(false); setSampling(false); }}><X size={18}/></Button></div>
        <p className="seat-editing-help">The highlighted seat is the one you’re editing.</p><label htmlFor="edit-seat">Person / seat</label><select id="edit-seat" data-slot="native-select" value={editing} onChange={event => { edit(seats.find(s => s.id === Number(event.target.value))); }}>{seats.map(s => <option key={s.id} value={s.id}>{s.self ? 'You' : `Seat ${s.id}`} — {s.name || 'Unnamed'}</option>)}</select><label htmlFor="seat-name">{seat.self ? 'Your name' : 'Name'}</label><input id="seat-name" autoFocus maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder={seat.self ? 'What do people call you?' : 'e.g. Alice'}/>
        <p>{sampling ? 'Ask this person to speak briefly, on their own. Confirm their voice below.' : 'Name this seat now. Voice matching is optional and can be done later.'}</p>
        {sampling && <div className="voice-match" role="status"><MicWave active={live && !candidate}/>{candidate ? `Voice detected · Speaker ${candidate}` : live ? 'Waiting for a voice…' : 'Microphone off'}</div>}
        {candidate && <><p className="voice-sample">“{session.segments.filter(s => String(s.speaker) === candidate).slice(-16).map(s => s.text).join(' ')}”</p>{ownVoiceConflict ? <p role="alert">That is your voice. Try again with this person speaking alone; your voice cannot be assigned to someone else.</p> : seats.some(s => s.id !== seat.id && s.speaker === candidate) && <p>This voice is already assigned to another person. Clear that person’s voice match first if it was incorrect.</p>}</>}
        {detectedVoices.length > 0 && <><label htmlFor="detected-voice">Or choose a voice already heard</label><select id="detected-voice" data-slot="native-select" value={candidate} onChange={event => { setSampling(false); setCandidate(event.target.value); }}><option value="">Choose a detected voice</option>{detectedVoices.map(id => <option key={id} value={id}>Speaker {id}{seats.find(s => s.speaker === id)?.name ? ` · ${seats.find(s => s.speaker === id).name}` : ' · not matched'}</option>)}</select></>}
        {seat.speaker && <Button type="button" variant="ghost" onClick={() => { setSeats(previous => previous.map(s => s.id === editing ? { ...s, speaker: null } : s)); setCandidate(''); setSampling(false); }}>Clear this voice match</Button>}
        <Button type="submit" disabled={!name.trim() || voiceConflict}>{candidate ? `Yes, this is ${name.trim() || 'this person'}` : guided ? seats.at(-1).id === editing ? 'Save and finish' : 'Save and continue' : 'Save name'}</Button><Button type="button" variant="outline" disabled={!live} onClick={sample}>{sampling ? 'Try another voice' : 'Match voice (optional)'}</Button>{sampling && <Button type="button" variant="ghost" disabled={!name.trim()} onClick={() => savePerson(false)}>Skip voice matching</Button>}{guided && seats.findIndex(s => s.id === editing) > 0 && <Button type="button" variant="ghost" onClick={() => edit(seats[seats.findIndex(s => s.id === editing) - 1])}>Previous person</Button>}
        <p className="table-fine">You confirm the match. You can change it at any time.</p>
      </form> : stage === 'setup' ? <div className="table-setup-card"><span className="table-icon"><Users size={26}/></span>{!setupChoice ? <><h3>First, what’s your name?</h3><p>This names your seat and tells us which name to listen for.</p><label htmlFor="mention-names">Your name</label><input id="mention-names" value={aliases} maxLength={200} onChange={e => updateAlertNames(e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && aliases.split(',')[0].trim()) { event.preventDefault(); setSetupChoice(true); } }} placeholder="Your name, nickname"/><p className="table-fine">Add nicknames separated by commas.</p><Button disabled={!aliases.split(',')[0].trim()} onClick={() => setSetupChoice(true)}>Next<ChevronRight size={18}/></Button></> : <><h3>How would you like to name people?</h3><p>Your seat is {seats.find(s => s.self)?.name || 'You'}. Choose how to connect names to voices.</p><Button onClick={() => { setStage('conversation'); setGuided(false); setTranscriptNaming(true); }}>Name people in the transcript<ChevronRight size={18}/></Button><p className="table-fine">You name each person: click their speaker label in the transcript, type their name, and save. Do this for your own voice too.</p><Button variant="outline" onClick={() => { setTranscriptNaming(false); setGuided(true); edit(seats[0]); sample(); }}>Use voice identification<ChevronRight size={18}/></Button><p className="table-fine">Go person by person, asking each to speak and confirming their name. You can skip voice matching.</p><Button variant="ghost" onClick={() => setSetupChoice(false)}>Change your name</Button><p className="table-fine">Name alerts turn on after your own voice is identified.</p></>}</div> : null}
    </div>
    {stage === 'conversation' && active && <>
      {unmatchedVoices.length > 0 && <details className="unmatched-voices"><summary>{unmatchedVoices.length} unmatched voice{unmatchedVoices.length === 1 ? '' : 's'} · Link to a person</summary><p>Click a speaker label in the transcript, type their name, and save. Or choose a person and match their detected voice below.</p><Button variant="outline" onClick={() => { setGuided(false); setStage('setup'); edit(seats.find(s => s.name && !s.speaker) || seats[0]); }}>Match a detected voice</Button></details>}
      <div className="following-strip"><Users size={20}/><div><strong>{names.length ? `Following ${names.join(' + ')}` : 'Following everyone'}</strong>{transcriptNaming && (!detectedVoices.length || unmatchedVoices.length > 0 || !seats.find(s => s.self)?.speaker) && <p className="table-naming-hint">You name each person: click their speaker label, type their name, and save. Do this for your own voice too.</p>}</div></div>{selected.some(id => !seats.find(s => s.id === id)?.speaker) && <div className="table-match-notice" role="status">Selected people need a voice match before their captions can be filtered. <button onClick={() => { setStage('setup'); setGuided(false); edit(seats.find(s => selected.includes(s.id) && !s.speaker)); }}>Match selected person</button></div>}
      {filtered.segments.length || filtered.partialRuns?.length ? <Conversation onRename={renameCaptionSpeaker} speakerStyles={speakerStyles} session={filtered} live={live && active} holding={holding} heldSession={held ? selected.length ? filterSession(namedSession(held, seats), followed) : namedSession(held, seats) : filtered} textSize={size} announce={announce && active} onReturn={onReturn}/> : <p id="transcript" tabIndex={0} className="table-caption-wait" role="status">{live ? 'Listening for your conversation…' : 'Start captions when your table is ready.'}</p>}
      {selected.length > 0 && <details className="other-conversation"><summary>Other conversation · {other.length ? 'Recent words available' : 'No words yet'}</summary><div>{other.length ? captionGroups(other.slice(-80)).map(s => <p key={s.id}><SpeakerLabel id={s.speaker} name={named.speakers?.[s.speaker] || (s.speaker ? `Speaker ${s.speaker}` : 'Unidentified')} onRename={renameCaptionSpeaker}/>{' '}{s.text}</p>) : <p>Words from people you aren’t following will appear here.</p>}</div></details>}
      <p className="table-legend">{aliases.trim() && !seats.find(s => s.self)?.speaker && 'Mention alerts are off until you match your own voice. '}Long-press or right-click a person for recent words. Names and seats stay put; match voices again for each new session.</p>
    </>}
  </div>;
}
function MicWave({ active }) { return <span className={`mic-wave ${active ? 'active' : ''}`} aria-hidden="true">{[8, 16, 24, 13, 30, 18, 10].map((height, i) => <i key={i} style={{ height }}/>)}</span>; }
