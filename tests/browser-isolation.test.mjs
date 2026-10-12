import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { prepareIsolation } from '../src/browser/isolation.js';
function environment({ isolated = false, attempted = false, registrationError = false } = {}) {
  const scriptURL = 'https://example.test/scribe/isolation-worker.js';
  const storage = new Map(attempted ? [['scribe.isolation-reload:/scribe/', 'attempted']] : []);
  const listeners = new Map();
  const env = { crossOriginIsolated: isolated, isSecureContext:true, setTimeout, clearTimeout,
    sessionStorage:{ getItem:key=>storage.get(key), setItem:(key,value)=>storage.set(key,value), removeItem:key=>storage.delete(key) },
    location:{href:'https://example.test/scribe/browser.html',reload(){env.reloads++;}}, reloads:0,
    navigator:{serviceWorker:{controller:null, getRegistration:async()=>undefined,
      addEventListener:(name,fn)=>listeners.set(name,fn), removeEventListener:name=>listeners.delete(name),
      async register(url, options) { env.registered={url,options}; if(registrationError) throw Error('Blocked'); this.controller={scriptURL}; listeners.get('controllerchange')?.(); }
    }} };
  return {env,storage,listeners};
}
test('first visit installs within repository subpath and reloads once before app startup',async()=>{
 const {env,listeners}=environment();
 assert.equal(await prepareIsolation(env),'reloading');
 assert.equal(env.reloads,1);
 assert.equal(env.registered.url,'https://example.test/scribe/isolation-worker.js');
 assert.equal(env.registered.options.scope,'https://example.test/scribe/');
 assert.equal(listeners.size,0);
 await prepareIsolation(env); assert.equal(env.reloads,1);
});
test('isolated pages need no worker and clear retry marker',async()=>{
 const {env,storage}=environment({isolated:true,attempted:true});
 await prepareIsolation(env); assert.equal(env.registered,undefined); assert.equal(storage.size,0);
});
test('blocked registration, storage, or existing app worker safely continues without reloading',async()=>{
 const {env}=environment({registrationError:true}); await prepareIsolation(env); assert.equal(env.reloads,0);
 const blocked=environment().env; blocked.sessionStorage.getItem=()=>{throw Error('Storage blocked');};
 await prepareIsolation(blocked); assert.equal(blocked.registered,undefined);
 const other=environment().env; other.navigator.serviceWorker.getRegistration=async()=>({active:{scriptURL:'https://example.test/other.js'}});
 await prepareIsolation(other); assert.equal(other.registered,undefined);
});
test('service worker adds isolation headers only within its app and streams response bodies',async()=>{
 const handlers={};
 const context={self:{location:{origin:'https://example.test'}, registration:{scope:'https://example.test/scribe/'}, addEventListener:(name,fn)=>handlers[name]=fn}, URL,Headers,Response,
 fetch:async()=>new Response('body',{headers:{'Content-Type':'application/javascript'}})};
 vm.runInNewContext(await readFile(new URL('../public/isolation-worker.js',import.meta.url),'utf8'),context);
 let response;
 handlers.fetch({request:new Request('https://example.test/scribe/assets/worker.js'),respondWith:p=>response=p});
 const result=await response;
 assert.equal(result.headers.get('Cross-Origin-Opener-Policy'),'same-origin');
 assert.equal(result.headers.get('Cross-Origin-Embedder-Policy'),'require-corp');
 assert.equal(result.headers.get('Content-Type'),'application/javascript');
 assert.equal(await result.text(),'body');
 for(const url of ['https://huggingface.co/model','https://example.test/other/app.js']) {
   handlers.fetch({request:new Request(url),respondWith:()=>assert.fail('Unrelated requests must bypass worker')});
 }
});
