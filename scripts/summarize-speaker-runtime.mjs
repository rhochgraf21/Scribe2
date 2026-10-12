// Summarize captured local browser benchmarks without including transcript text.
// Usage: node scripts/summarize-speaker-runtime.mjs /absolute/path/report.json
import { readFile } from 'node:fs/promises';
const { reports, errors } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const baseline = reports.find(r => !Object.values(r.speakerRuntimeOptions || {}).some(Boolean));
if (!baseline) throw Error('Missing unprofiled default-settings baseline');
const rows = reports.filter(r => !r.speakerRuntimeOptions?.enableProfiling).map(r => ({
  options: r.speakerRuntimeOptions || {},
  speed: r.speed,
  wallSeconds: r.wallMs / 1000,
  speakerComputeSeconds: r.stages.find(s=>s.role==='diar').metrics.speakerInferenceMs / 1000,
  sameCaptionsAndSpeakers: JSON.stringify(r.segments) === JSON.stringify(baseline.segments),
  sameWorkload: r.audioSeconds === baseline.audioSeconds && JSON.stringify(r.plan) === JSON.stringify(baseline.plan)
    && r.speakerChunkFrames === baseline.speakerChunkFrames && r.speakerHistoryFrames === baseline.speakerHistoryFrames,
}));
const profileRun = reports.find(r => r.speakerRuntimeOptions?.enableProfiling);
const profile = (profileRun?.operatorProfiles || profileRun?.profileMessages)?.[0];
const total = profile?.operators.reduce((sum, row) => sum + row.totalMs, 0);
console.log(JSON.stringify({ errors, runs:rows, profile:profile ? {
  calls:profile.runs, events:profile.events,
  operators:profile.operators.map(row=>({name:row.name, percent:100*row.totalMs/total, ...row})),
  slowestNodes:profile.nodes.slice(0,10),
} : null }, null, 2));
if (errors?.length || rows.some(r=>!r.sameWorkload || !r.sameCaptionsAndSpeakers)) process.exitCode = 1;
