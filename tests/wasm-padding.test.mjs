import test from 'node:test';
import assert from 'node:assert/strict';
import { useWasmPadding } from '../src/browser/wasm-padding.js';
test('WebKit defaults include Safari and iOS browser brands but exclude desktop Chromium', () => {
  for (const ua of ['Macintosh AppleWebKit/605.1.15 Version/26 Safari/605.1.15', 'iPhone AppleWebKit/605.1.15 CriOS/140 Mobile Safari/604.1', 'iPad AppleWebKit/605.1.15 FxiOS/140 Mobile']) {
    assert.equal(useWasmPadding('', {userAgent:ua}), true);
    assert.equal(useWasmPadding('?wasm-padding=0', {userAgent:ua}), false);
  }
  assert.equal(useWasmPadding('', {platform:'MacIntel',maxTouchPoints:5}), true);
  for (const ua of ['', 'Gecko/20100101 Firefox/140', 'AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Android AppleWebKit/537.36 Chrome/140']) {
    assert.equal(useWasmPadding('', {userAgent:ua}), false);
    assert.equal(useWasmPadding('?wasm-padding=1', {userAgent:ua}), true);
  }
});
