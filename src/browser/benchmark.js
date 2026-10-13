// Included only by an explicit SCRIBE_BROWSER_BENCHMARK=1 build. Test audio is
// passed through Chrome's debugging pipe, never uploaded to any HTTP endpoint.
import { modelProfiles, downloadModels } from './model-import';
import { InferenceClient } from './inference-client';
import { applyCaptionPatch } from './caption-updates';
window.runCpuBenchmark = async ({ mode, jointMode, device = 'wasm', modelProfile = 'standard', threadBudget = 4, fixedShapes = false, speakerChunkFrames = 11, speakerHistoryFrames = 200, speakerFixedBatch = false, speakerSilenceSkipping = true, speakerRuntimeOptions = {}, speakerAccuracyLevel = 0, speakerGraphBase64, speakerGraphSha256, realtime = false, pcmBase64 }) => {
  const bytes = Uint8Array.from(atob(pcmBase64),c=>c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const client = new InferenceClient({mode,jointMode,device,threadBudget});
  let session={segments:[]}, start, firstCaptionMs, done, fail;
  const stopped = new Promise((resolve,reject)=>{done=resolve;fail=reject;});
  const progress = { mode,jointMode,device,state:'loading', audioSeconds:pcm.length/16000 };
  window.cpuBenchmarkProgress=progress;
  let ready;
  const loaded=new Promise(resolve=>{ready=resolve;});
  const warnings = [], operatorProfiles = []; let maxDiarLag = 0;
  let waiting = null, sentSamples = 0, ackedSamples = 0;
  client.onmessage=({data})=>{
    if(data.type==='speaker-profile') operatorProfiles.push(data.profile);
    if(data.type==='warning') warnings.push(data.message);
    if(data.type==='diar-progress') maxDiarLag = Math.max(maxDiarLag, data.lagSeconds);
    if(data.type==='error') { fail(Error(data.message)); ready(); waiting?.(); }
    if(data.type==='ready') {progress.plan=data.plan;ready();}
    if(data.type==='captions') {
      session=applyCaptionPatch(session,data);
      if(firstCaptionMs===undefined && session.segments.length) firstCaptionMs=performance.now()-start;
    }
    if(data.type==='ack') {ackedSamples += data.samples; progress.processedSeconds=data.audioSeconds;waiting?.();waiting=null;}
    if(data.type==='stopped') done(data);
  };
  try {
    const {files:modelFiles}=await downloadModels(message=>progress.status=message,{entries:modelProfiles[modelProfile].entries,fetcher:()=>{throw Error('Import or download benchmark models first');}});
    if (speakerAccuracyLevel === 4) {
      if (!speakerGraphBase64 || !speakerGraphSha256) throw Error('Missing experimental speaker graph');
      const graph = Uint8Array.from(atob(speakerGraphBase64), c=>c.charCodeAt(0));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',graph))].map(x=>x.toString(16).padStart(2,'0')).join('');
      if (digest !== speakerGraphSha256) throw Error('Experimental speaker graph checksum mismatch');
      modelFiles['diar/onnx/model_quantized.onnx'] = new Blob([graph]);
    } else if (speakerAccuracyLevel !== 0 || speakerGraphBase64) throw Error('Invalid speaker graph experiment');
    client.postMessage({type:'load',speakerCompareOutputs:true,speakerSilenceSkipping,fixedShapes,speakerChunkFrames,speakerHistoryFrames,speakerFixedBatch,speakerRuntimeOptions,modelProfile,modelFiles,assetBase:new URL('.',document.baseURI).href});
    // Attach rejection handler immediately, including model-load failures.
    await Promise.race([loaded,stopped]);
    start=performance.now(); progress.state='running';client.postMessage({type:'start'});
    // Bounded three-second pipeline permits ASR to advance while speaker
    // inference is busy, as it does with a continuous microphone stream.
    for(let offset=0;offset<pcm.length;offset+=8960){
      while(sentSamples-ackedSamples >= 48000) {
        const ack=new Promise(resolve=>{waiting=resolve;});
        await Promise.race([ack,stopped]);
      }
      if (realtime) await new Promise(resolve=>setTimeout(resolve,Math.max(0,((offset+Math.min(8960,pcm.length-offset))/16000)*1000-(performance.now()-start))));
      const samples=Float32Array.from(pcm.subarray(offset,offset+8960),x=>x/32768);
      sentSamples += samples.length;
      client.postMessage({type:'audio',samples:samples.buffer});
    }
    client.postMessage({type:'stop'});
    const result=await stopped;
    const wallMs=performance.now()-start;
    const report={speakerAccuracyLevel,speakerGraphSha256,mode,jointMode,device,modelProfile,threadBudget,fixedShapes,speakerChunkFrames,speakerHistoryFrames,speakerFixedBatch,speakerRuntimeOptions,diagnostics:result.diagnostics,realtime,warnings,operatorProfiles,maxDiarLag,plan:progress.plan,audioSeconds:pcm.length/16000,wallMs,firstCaptionMs,speed:(pcm.length/16000)/(wallMs/1000),stages:result.stages,segments:session.segments};
    progress.state='complete';return report;
  } finally {client.terminate();}
};
