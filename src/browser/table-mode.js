export function makeSeats(count = 4) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: '', speaker: null, self: i === 0, ...seatPosition(i, count) }));
}
export function seatPosition(index, count) {
  const angle = Math.PI / 2 + index * Math.PI * 2 / count;
  return { x: 50 + 36 * Math.cos(angle), y: 50 + 35 * Math.sin(angle) };
}
export function bindSeat(seats, id, speaker, name) {
  const target = seats.find(seat => seat.id === id);
  if (!target || !/^[1-9]\d*$/.test(String(speaker))) return seats;
  // A different seat may never take the user's confirmed voice.
  if (seats.some(seat => seat.id !== id && String(seat.speaker) === String(speaker))) return seats;
  return seats.map(seat => seat.id === id ? { ...seat, name: name.trim(), speaker: String(speaker) } : String(seat.speaker) === String(speaker) ? { ...seat, speaker: null } : seat);
}
export function namedSession(session, seats) {
  return { ...session, speakers: { ...session.speakers, ...Object.fromEntries(seats.filter(s => s.speaker).map(s => [s.speaker, s.name || (s.self ? 'You' : `Seat ${s.id}`)])) } };
}
export function filterSession(session, speakers) {
  const includes = segment => segment.speaker != null && speakers.has(String(segment.speaker));
  return { ...session, segments: session.segments.filter(includes), partial: '', partialRuns: (session.partialRuns || []).filter(includes) };
}
export function mentionAlerts(session, names, followed) {
  const aliases = names.split(',').map(n => n.trim()).filter(Boolean);
  if (!aliases.length) return [];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${aliases.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
  const turns = captionGroups(session.segments);
  return turns.filter(turn => !followed.has(String(turn.speaker)) && pattern.test(turn.text)).map(turn => ({ ...turn, key: `${turn.id}:${turn.speaker}` }));
}

export function captionGroups(segments) {
  const turns = [];
  for (const segment of segments) {
    let turn = turns.at(-1);
    if (!turn || turn.speaker !== segment.speaker) { turn = { id: segment.id, speaker: segment.speaker, text: '' }; turns.push(turn); }
    turn.text += `${turn.text && !/^[,.;:!?]/.test(segment.text) ? ' ' : ''}${segment.text}`;
  }
  return turns;
}

export function resizeSeats(seats, count, nextId) {
  const size = Math.max(2, Math.min(8, Math.floor(count)));
  if (!Number.isFinite(size) || size === seats.length) return seats;
  if (size < seats.length) return seats.slice(0, size);
  const next = [...seats];
  let id = Math.max(nextId || 1, ...seats.map(s => s.id + 1));
  while (next.length < size) {
    // Fill the largest gap without moving seats the user already arranged.
    const positions = Array.from({length:32}, (_, i) => seatPosition(i, 32));
    const distance = point => Math.min(...next.map(s => (point.x - s.x) ** 2 + (point.y - s.y) ** 2));
    const position = positions.reduce((best, point) => distance(point) > distance(best) ? point : best);
    next.push({id:id++, name:'', speaker:null, self:false, ...position});
  }
  return next;
}

export function tableMentionAlerts(session, names, seats, followed, ownVoiceHistory = []) {
  const own = seats.find(seat => seat.self);
  // Without a confirmed own voice we cannot safely distinguish self-mentions.
  if (!own?.speaker) return [];
  const excluded = new Set([...followed, ...ownVoiceHistory, own.speaker].map(String));
  return mentionAlerts(session, names, excluded).filter(alert => alert.speaker != null);
}

export function freshVoiceCandidate(segments, baselineIds) {
  // Delayed labels on pre-existing words do not belong to this voice sample.
  const fresh = segments.filter(segment => !baselineIds.has(segment.id) && segment.speaker != null).slice(-12);
  if (fresh.length < 3) return '';
  const ids = new Set(fresh.map(segment => String(segment.speaker)));
  return ids.size === 1 ? String(fresh.at(-1).speaker) : '';
}

// Caption-label naming confirms this specific voice, without moving other matches.
export function nameTableSpeaker(seats, speaker, value, ownVoiceHistory = []) {
  const id = String(speaker), name = value.trim();
  if (!/^[1-9]\d*$/.test(id) || !name || name.length > 80) return seats;
  const bound = seats.find(seat => String(seat.speaker) === id);
  if (bound) return seats.map(seat => seat.id === bound.id ? { ...seat, name } : seat);
  const matches = seats.filter(seat => seat.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  // Duplicate names or an already-matched namesake need an explicit seat choice.
  if (matches.length > 1 || matches[0]?.speaker) return seats;
  const target = matches[0] || seats.find(seat => !seat.self && !seat.name && !seat.speaker);
  if (!target || (!target.self && ownVoiceHistory.map(String).includes(id))) return seats;
  return bindSeat(seats, target.id, id, name);
}
