export const speechOnlyDescription = 'Live captions only. Speaker labels, Table mode, individual filtering, and name alerts are unavailable without speaker detection.';

export function captionDefaults(browser = globalThis.navigator) {
  const phone = Boolean(browser?.userAgentData?.mobile || /iPhone|iPod|Android.*Mobile/i.test(browser?.userAgent || ''));
  return { phone, cpuMode: phone ? 'sequential' : 'parallel', speakerDtype: phone ? 'q4' : 'q8', modelProfile: phone ? 'moonshine-tiny' : 'standard', speakerDetection: !phone, device: phone ? 'wasm' : 'webgpu' };
}

export function captionModelEntries(profile, speakerDetection = true, speakerEntries) {
  const speech = profile.entries.filter(file => !file.path.startsWith('diar/'));
  return speakerDetection ? speakerEntries ? [...speech, ...speakerEntries] : profile.entries : speech;
}
