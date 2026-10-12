// Finish isolation setup before mounting the app: a first-visit reload must
// never interrupt model imports, downloads, or an active caption session.
export let isolationStatus = '';
export async function prepareIsolation(env = globalThis) {
  const marker = `scribe.isolation-reload:${new URL('.', env.location.href).pathname}`;
  if (env.crossOriginIsolated) {
    try { env.sessionStorage.removeItem(marker); } catch { /* Storage may be disabled. */ }
    isolationStatus = 'Cross-origin isolation is active.';
    return;
  }
  if (!env.isSecureContext || !env.navigator.serviceWorker) {
    isolationStatus = 'Automatic multithreading setup requires HTTPS and service-worker support.';
    return;
  }
  const workers = env.navigator.serviceWorker;
  const script = new URL('./isolation-worker.js', env.location.href);
  const scope = new URL('.', script).href;
  let timer, changed;
  try {
    // Do not replace another application's service worker.
    const existing = await workers.getRegistration(scope);
    const owner = existing?.active || existing?.waiting || existing?.installing;
    if (owner && owner.scriptURL !== script.href) {
      isolationStatus = 'Another service worker controls this page; automatic isolation was not enabled.';
      return;
    }
    if (env.sessionStorage.getItem(marker)) {
      isolationStatus = 'Automatic isolation was attempted, but this browser still limits CPU inference to one thread.';
      return;
    }
    // Check storage before registering; it is the guard against reload loops.
    env.sessionStorage.setItem(marker, 'pending');
    env.sessionStorage.removeItem(marker);
    const controlled = new Promise((resolve, reject) => {
      changed = () => { if (workers.controller?.scriptURL === script.href) resolve(); };
      workers.addEventListener('controllerchange', changed);
      timer = env.setTimeout(() => reject(Error('Isolation setup timed out. Refresh to retry.')), 8000);
      changed();
    });
    await Promise.all([workers.register(script.href, { scope, updateViaCache: 'none' }), controlled]);
    env.sessionStorage.setItem(marker, 'attempted');
    isolationStatus = 'Enabling CPU multithreading…';
    env.location.reload();
    return 'reloading';
  } catch (error) {
    isolationStatus = `Automatic multithreading setup unavailable: ${error.message || 'browser storage or service workers are blocked'}`;
  } finally {
    env.clearTimeout(timer);
    if (changed) workers.removeEventListener('controllerchange', changed);
  }
}
