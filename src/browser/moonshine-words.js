// ONNX export exposes tokens, not alignment. Preserve first-observed times for
// an unchanged prefix; spread revised/new words over the remaining audio span.
export function reviseWords(previous, text, start, end, final) {
  const parts = text.match(/\S+/gu) || [];
  let common = 0;
  while (common < parts.length && common < previous.length && parts[common] === previous[common].text) common++;
  const first = common ? previous[common - 1].time : start;
  const span = Math.max(0, end - first);
  return parts.map((text, i) => ({ text, time: i < common ? previous[i].time : first + span * (i - common + .5) / (parts.length - common), stable: final, retainFrom: start }));
}
export function wordChangeStart(previous, words) {
  let from = 0;
  while (from < previous.length && from < words.length && previous[from].text === words[from].text && previous[from].time === words[from].time && previous[from].stable === words[from].stable) from++;
  return from;
}
