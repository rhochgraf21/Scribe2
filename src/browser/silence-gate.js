// Deliberately conservative near-silence detection, not a speech classifier.
// Check short windows so a brief/quiet onset cannot disappear in a chunk average.
export class SilenceGate {
  constructor() { this.reset(); }
  reset() { this.quietSeconds = 0; }
  shouldSkip(samples, stepSeconds, eligible = true) {
    let quiet = samples.length > 0;
    for (let offset = 0; quiet && offset < samples.length; offset += 320) {
      const end = Math.min(samples.length, offset + 320);
      let energy = 0;
      for (let i = offset; i < end; i++) {
        const value = samples[i];
        if (!Number.isFinite(value) || Math.abs(value) > .002) { quiet = false; break; }
        energy += value * value;
      }
      if (energy / (end - offset) > .0005 ** 2) quiet = false;
    }
    this.quietSeconds = quiet ? this.quietSeconds + stepSeconds : 0;
    // Keep at least the first full quiet chunk after speech in model context.
    return eligible && quiet && this.quietSeconds >= 1.5;
  }
}
