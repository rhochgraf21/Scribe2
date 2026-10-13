// AppleWebKit also appears in Chromium user agents, so exclude those engines.
// iOS browsers (including their alternate brand tokens) use the WebKit default.
export function useWasmPadding(search = '', navigatorInfo = {}) {
  const override = new URLSearchParams(search).get('wasm-padding');
  if (override === '1' || override === '0') return override === '1';
  const ua = navigatorInfo.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) ||
    (navigatorInfo.platform === 'MacIntel' && navigatorInfo.maxTouchPoints > 1);
  return ios || (/AppleWebKit\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Android/.test(ua));
}
