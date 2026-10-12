// ONNX's WASM profiler prints a Chrome trace as one JSON event per console line.
// Retain bounded aggregates, not the full trace or tensor contents. dur is in µs.
export function createOperatorProfile() {
  const operators = new Map(), nodes = new Map();
  let runs = 0, events = 0;
  function add(map, key, event) {
    if (!map.has(key) && map.size >= 2048) return;
    const row = map.get(key) || { name:key, calls:0, totalMs:0, maxMs:0, steadyCalls:0, steadyMs:0 };
    const ms = event.dur / 1000;
    row.calls++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    // After ~40 seconds with the current 880 ms chunk: filled speaker cache.
    if (runs >= 46) { row.steadyCalls++; row.steadyMs += ms; }
    map.set(key, row);
  }
  return {
    consume(message) {
      const line = message.trim();
      if (line === '[' || line === ']') return true;
      if (!line.startsWith('{')) return false;
      let event;
      try { event = JSON.parse(line.replace(/,$/, '')); } catch { return false; }
      if (!event.cat || !event.name) return false;
      if (event.cat === 'Session' && event.name === 'model_run') runs++;
      if (event.cat === 'Node' && event.name.endsWith('_kernel_time') && Number.isFinite(event.dur) && event.dur >= 0) {
        events++;
        add(operators, `${event.args?.provider || 'unknown'} / ${event.args?.op_name || 'unknown'}`, event);
        add(nodes, event.name, event);
      }
      return true;
    },
    snapshot() {
      const rows = map => [...map.values()].sort((a,b) => b.totalMs-a.totalMs).map(row=>({...row}));
      return { runs, events, steadyAfterRuns:46, operators:rows(operators), nodes:rows(nodes) };
    },
  };
}
