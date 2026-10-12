// Names belong to stable diarization IDs, independently of caption revisions.
export function renameSpeaker(session, id, value) {
  if (!/^[1-9]\d*$/.test(String(id))) throw Error('Cannot name an unidentified speaker');
  const name = value.trim();
  if (!name || name.length > 80) throw Error('Use a speaker name between 1 and 80 characters');
  return { ...session, speakers: { ...session.speakers, [id]: name } };
}

export function transcriptText(session, showSpeakers = true) {
  if (!showSpeakers) return session.segments.map(segment => segment.text).join(' ');
  const lines = [];
  let previous;
  for (const segment of session.segments) {
    const name = session.speakers?.[segment.speaker] || (segment.speaker ? `Speaker ${segment.speaker}` : 'Speaker ?');
    if (lines.length && segment.speaker === previous) lines[lines.length - 1] += ` ${segment.text}`;
    else lines.push(`[${name}] ${segment.text}`);
    previous = segment.speaker;
  }
  return lines.join('\n');
}
