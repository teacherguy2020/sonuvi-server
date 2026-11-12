import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
class Element {
  constructor(tag, doc) { this.tagName=tag; this.doc=doc; this.children=[]; this.style={}; this.parent=null; this.textContent=''; this.onclick=null; }
  set id(value) { this._id=value; this.doc.ids.set(value,this); }
  get id() { return this._id; }
  set innerHTML(value) { this._innerHTML=value; for (const id of ['sonuviPairStatus','sonuviPairQr','sonuviPairCode','sonuviPairStart','sonuviSessionRetry']) { if (value.includes('id="'+id+'"')) { const child=new Element(id.includes('Start')||id.includes('Retry')?'button':'div',this.doc); child.id=id; this.append(child); } } }
  append(...items) { for (const item of items) { item.parent=this; this.children.push(item); } }
  querySelector(selector) { if (selector.startsWith('#')) return this.doc.getElementById(selector.slice(1)); if (selector==='button') return this.children.find(child=>child.tagName==='button'); return null; }
  remove() { if (this.parent) this.parent.children=this.parent.children.filter(child=>child!==this); for (const child of this.children) child.remove(); if (this.id) this.doc.ids.delete(this.id); }
}
function browser(responses) {
  const doc={ids:new Map(), listener:null, body:null, createElement(tag){return new Element(tag,this);}, getElementById(id){return this.ids.get(id)||null;}, addEventListener(_name,listener){this.listener=listener;}};
  doc.body=new Element('body',doc);
  const calls=[];
  const sandbox={URL,Headers,Promise,Map,encodeURIComponent,JSON,Error,document:doc,window:null,location:{href:'https://controller.test/controller.html',origin:'https://controller.test',reload(){}},setTimeout(){return 1;},clearTimeout(){},SonuviControllerWeb:true,fetch:async (input)=>{calls.push(String(input));const next=responses.shift();if(next instanceof Error) throw next;return {status:next.status,ok:next.status>=200&&next.status<300,json:async()=>next.body};}};
  sandbox.window=sandbox;
  return {doc,sandbox,calls};
}
async function load(responses) {
  const source=await fs.readFile(path.join(root,'scripts/controller-browser-auth.js'),'utf8');
  const state=browser(responses);state.sandbox.source=source;
  vm.runInNewContext(source,state.sandbox);
  await state.doc.listener();
  return state;
}
test('browser session retries transient failures without re-pairing and clears the overlay on success', async () => {
  const state=await load([{status:503,body:{error:'upstream unavailable'}},{status:200,body:{authenticated:true,csrfToken:'csrf'}},{status:200,body:{authenticated:true,csrfToken:'csrf'}}]);
  const retry=state.doc.getElementById('sonuviSessionRetry');
  assert.equal(state.doc.getElementById('sonuviPairStart').style.display,'none');assert.equal(retry.style.display,'inline-block');
  await retry.onclick();
  assert.equal(state.sandbox.SonuviControllerAuth.csrfToken,'csrf');assert.equal(state.doc.getElementById('sonuviBrowserPairing'),null);
  assert.equal(state.doc.body.children.filter(child=>child.textContent==='Pair a browser').length,1);
  await retry.onclick();assert.equal(state.doc.body.children.filter(child=>child.textContent==='Pair a browser').length,1);
});
test('browser session offers Retry after a network failure but pairing only after unauthenticated response', async () => {
  const transient=await load([new Error('network down'),{status:200,body:{authenticated:true,csrfToken:'csrf'}}]);
  assert.equal(transient.doc.getElementById('sonuviPairStart').style.display,'none');await transient.doc.getElementById('sonuviSessionRetry').onclick();assert.equal(transient.doc.getElementById('sonuviBrowserPairing'),null);
  const unauthenticated=await load([{status:401,body:{error:'Trusted-device approval is required.'}}]);
  assert.equal(unauthenticated.doc.getElementById('sonuviPairStart').style.display,'inline-block');assert.equal(unauthenticated.doc.getElementById('sonuviSessionRetry').style.display,'none');
});
test('pairing poll copy does not claim an approval before one exists', async () => {
  const source=await fs.readFile(path.join(root,'scripts/controller-browser-auth.js'),'utf8');
  assert.doesNotMatch(source,/Retrying the approved pairing/);
});
