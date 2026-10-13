// Observe devices created by ORT without changing requested features/limits or
// adding error scopes that could swallow errors the runtime expects to handle.
export function installGpuDiagnostics(scope, report, fatal) {
  const seen = new WeakSet();
  const observe = device => {
    if (!device || seen.has(device)) return;
    seen.add(device);
    device.addEventListener('uncapturederror', event => report({kind:'gpu-uncaptured',name:event.error?.constructor?.name,message:event.error?.message}));
    device.lost.then(info => {
      report({kind:'gpu-device-lost',reason:info.reason,message:info.message});
      fatal(`GPU device lost: ${info.reason || 'unknown'}. Refresh to restart the test.`);
    });
    report({kind:'gpu-observer-ready'});
  };
  try {
    const prototype = scope.GPUAdapter?.prototype;
    if (!prototype?.requestDevice) throw Error('GPUAdapter unavailable');
    const original = prototype.requestDevice;
    prototype.requestDevice = async function (...args) {
      let device;
      try { device = await original.apply(this,args); }
      catch (error) { report({kind:'gpu-device-request',name:error.name,message:error.message}); throw error; }
      try { observe(device); } catch { report({kind:'gpu-observer-unavailable'}); }
      return device;
    };
  } catch { report({kind:'gpu-observer-unavailable'}); }
  return observe;
}
