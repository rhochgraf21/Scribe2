export const VAD_FRAME = 512; // 32 ms at 16 kHz, plus 64 samples of model context.
const PRE = 1600, HOLD = 1600; // 100 ms lead-in and trailing protection.
export class SpeechActivity {
  constructor(infer) { this.infer = infer; this.reset(); }
  reset() {
    this.pending = new Float32Array(); this.context = new Float32Array(64);
    this.state = new Float32Array(256); this.processed = 0; this.ranges = [];
    this.speaking = false; this.probability = 0; this.frames = 0; this.computeMs = 0;
  }
  async push(samples) {
    const audio = new Float32Array(this.pending.length + samples.length);
    audio.set(this.pending); audio.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + VAD_FRAME <= audio.length; offset += VAD_FRAME) {
      const frame = audio.subarray(offset, offset + VAD_FRAME);
      const input = new Float32Array(64 + VAD_FRAME); input.set(this.context); input.set(frame,64);
      const started = performance.now();
      const result = await this.infer(input, this.state);
      this.computeMs += performance.now() - started;
      const p = result.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1 || result.state.length !== 256 || !result.state.every(Number.isFinite)) throw Error('Invalid VAD output');
      this.state = result.state; this.context.set(frame.subarray(VAD_FRAME - 64));
      this.probability = p; this.frames++;
      // Hysteresis avoids rapid switching around the speech threshold.
      this.speaking = p >= (this.speaking ? .3 : .45);
      if (this.speaking) {
        const start = Math.max(0,this.processed - PRE), end = this.processed + VAD_FRAME + HOLD;
        const last = this.ranges.at(-1);
        if (last && start <= last[1]) last[1] = end;
        else this.ranges.push([start,end]);
      }
      this.processed += VAD_FRAME;
    }
    this.pending = audio.slice(offset);
  }
  canSkip(start, end) {
    // Unknown trailing frames are never treated as silence. Wait enough for
    // a future speech onset to extend its protected lead-in back into this range.
    if (end + PRE > this.processed) return false;
    return !this.ranges.some(([a,b]) => a < end && b > start);
  }
  discardBefore(sample) { this.ranges = this.ranges.filter(([,end]) => end > sample); }
}
export async function loadSilero(ort, bytes) {
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders:['wasm'], enableCpuMemArena:false, enableMemPattern:false,
  });
  const detector = new SpeechActivity(async (input,state) => {
    const feeds = {input:new ort.Tensor('float32',input,[1,576]),state:new ort.Tensor('float32',state,[2,1,128])};
    if (session.inputNames.includes('sr')) feeds.sr = new ort.Tensor('int64',BigInt64Array.of(16000n),[]);
    let output;
    try {
      output = await session.run(feeds);
      return {probability:Number(output.output.data[0]),state:Float32Array.from(output.stateN.data)};
    } finally {
      for(const tensor of Object.values(feeds)) tensor.dispose();
      if(output) for(const tensor of Object.values(output)) tensor.dispose();
    }
  });
  detector.release = () => session.release();
  return detector;
}
