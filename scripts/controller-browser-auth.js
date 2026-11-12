/* Same-origin Sonuvi login; pairing remains optional. Device tokens stay on the Server. */
(() => {
  if (!globalThis.SonuviControllerWeb) return;
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const auth = globalThis.SonuviControllerAuth = { ready, enabled: true, csrfToken: '', role: 'controller' };
  let timer, readyResolved = false, approvalShown = false;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function(input, options = {}) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if(target.origin === location.origin && /^\/(?:config\/|recent\/|art\/|v1\/mobile\/|now-playing(?:\?|$)|next-up(?:\?|$)|podcasts(?:\/|\?|$))/.test(target.pathname)) await ready;
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (target.origin === location.origin && !['GET','HEAD','OPTIONS'].includes(method) && auth.csrfToken) {
      const headers = new Headers(options.headers || input?.headers);headers.set('x-csrf-token',auth.csrfToken);options={...options,headers};
    }
    return nativeFetch(input,options);
  };
  let playlistArtwork;
  auth.playlistArtwork = () => playlistArtwork ||= (async () => {
    await ready;
    const covers = new Map();
    let cursor = '';
    do {
      const response = await fetch('/v1/mobile/playlists?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {cache:'no-store'});
      if (!response.ok) throw new Error('Playlist artwork unavailable');
      const page = await response.json();
      for (const item of page.items || []) {
        if (/^pl_[\w-]{32}$/.test(item.id)) covers.set(String(item.name), location.origin + '/v1/mobile/playlists/' + item.id + '/artwork');
      }
      const next = page.nextCursor == null ? '' : String(page.nextCursor);
      if (next === cursor) break;
      cursor = next;
    } while (cursor);
    return covers;
  })().catch(error => { playlistArtwork = null; throw error; });
  const request = (path,options={}) => fetch('/__controller/'+path,{credentials:'same-origin',cache:'no-store',...options});
  function overlay() {
    let box=document.getElementById('sonuviBrowserPairing');if(box)return box;
    box=document.createElement('section');box.id='sonuviBrowserPairing';box.style.cssText='position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#07101df2;color:white;font:16px system-ui;text-align:center';
    box.innerHTML='<div style="max-width:400px;padding:24px"><h2>Sign in to Sonuvi</h2><p id="sonuviPairStatus">Checking secure access…</p><form id="sonuviLoginForm"><p><label>Username<br><input id="sonuviLoginUsername" name="username" autocomplete="username" maxlength="128" required></label></p><p><label>Password<br><input id="sonuviLoginPassword" name="password" type="password" autocomplete="current-password" maxlength="1024" required></label></p><button id="sonuviLoginSubmit" type="submit">Sign in</button></form><p>Use your Sonuvi account, not your Pi or SSH password. For a new Server, complete ownership setup in Sonuvi iOS or use verified host recovery.</p><img id="sonuviPairQr" alt="Pairing QR code" style="display:none;width:260px"><p id="sonuviPairCode"></p><button id="sonuviPairStart" type="button">Use trusted-device approval instead</button><button id="sonuviSessionRetry" style="display:none">Retry connection</button></div>';
    document.body.append(box);box.querySelector('#sonuviPairStart').onclick=start;
    box.querySelector('#sonuviLoginForm').onsubmit=signIn;return box;
  }
  async function signIn(event) {
    event.preventDefault();clearTimeout(timer);
    const box=overlay(),button=box.querySelector('#sonuviLoginSubmit'),password=box.querySelector('#sonuviLoginPassword');
    button.disabled=true;box.querySelector('#sonuviPairStatus').textContent='Signing in…';
    try {
      const r=await request('login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:box.querySelector('#sonuviLoginUsername').value.trim(),password:password.value})});
      const j=await r.json();password.value='';
      if(!r.ok)throw Error(j.error||'Sign-in was not accepted.');
      await checkSession();
    } catch(error) {box.querySelector('#sonuviPairStatus').textContent=error.message;}
    finally {password.value='';button.disabled=false;}
  }
  function transientSessionFailure(message) {
    const box=overlay();
    box.querySelector('#sonuviPairStatus').textContent=message;
    box.querySelector('#sonuviPairStart').style.display='none';
    box.querySelector('#sonuviLoginForm').style.display='none';
    const retry=box.querySelector('#sonuviSessionRetry');retry.style.display='inline-block';retry.onclick=checkSession;
  }
  async function poll(id) {
    try {
      const r=await request('pairings/'+encodeURIComponent(id)+'/complete');const j=await r.json();
      if(r.ok&&j.status==='approved'){location.reload();return;}
      if(!r.ok||['expired','rejected','cancelled','completed'].includes(j.status)){overlay().querySelector('#sonuviPairStatus').textContent=j.error||'Pairing ended. Start again.';return;}
      timer=setTimeout(()=>poll(id),1000);
    }catch{overlay().querySelector('#sonuviPairStatus').textContent='Connection lost while checking pairing approval. Retrying…';timer=setTimeout(()=>poll(id),2000);}
  }
  async function start() {
    clearTimeout(timer);const box=overlay(),status=box.querySelector('#sonuviPairStatus');
    try {
      const r=await request('pairings',{method:'POST'});const j=await r.json();
      if(!r.ok)throw new Error(j.error||'Could not start pairing');
      box.querySelector('#sonuviPairQr').src=j.qrDataUrl;box.querySelector('#sonuviPairQr').style.display='inline-block';
      box.querySelector('#sonuviPairCode').textContent=j.verificationCode;
      status.textContent='Enter this code on an already paired browser.';poll(j.presentationId);
    }catch(error){status.textContent=error.message;}
  }
  function browserApproval() {
    if(approvalShown)return;
    const settings=document.getElementById('sonuviAccountActions');
    if(!settings){
      if(window.top===window.self&&/^#pair-tv=[\w-]{16,160}$/.test(location.hash)) {
        location.href=(globalThis.innerWidth>=680?'controller-tablet-settings.html':'controller-mobile-settings.html')+location.hash;
      }
      return;
    }
    approvalShown=true;
    const card=document.getElementById('sonuviAccountSettings');if(card)card.hidden=false;
    const addAction=(button)=>{button.type='button';button.className='applyBtn';button.style.cssText='padding:10px 14px;border-radius:10px';settings.append(button);};
    if(auth.role==='administrator'){
      const trust=document.createElement('button');trust.textContent='Local device trust';addAction(trust);
      trust.onclick=async()=>{try{const r=await request('local-trust');const j=await r.json();if(!r.ok)throw Error(j.error||'Trust unavailable.');const dialog=document.createElement('dialog');dialog.style.cssText='max-width:650px;padding:24px';const heading=document.createElement('h2');heading.textContent='Enroll a private LAN client';dialog.append(heading);const note=document.createElement('p');note.textContent='Use only this already-trusted HTTPS browser. Copy the public trust document to the new client and independently compare the complete fingerprint here. Neither value grants a Sonuvi session. Never bypass a browser certificate warning.';dialog.append(note);const fingerprint=document.createElement('pre');fingerprint.textContent=j.fingerprint;fingerprint.style.whiteSpace='pre-wrap';dialog.append(fingerprint);const data=document.createElement('textarea');data.readOnly=true;data.value=JSON.stringify(j.localTrust);data.rows=8;data.style.width='100%';data.setAttribute('aria-label','Public Server trust document');dialog.append(data);const close=document.createElement('button');close.textContent='Close';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(close);document.body.append(dialog);dialog.showModal();}catch(error){alert(error.message);}};
    }
    const tv=document.createElement('button');tv.textContent='Authorize Apple TV';addAction(tv);
    tv.onclick=()=>{
      const dialog=document.createElement('dialog');dialog.style.cssText='max-width:520px;background:#142235;color:white;padding:24px;border-radius:12px';
      const heading=document.createElement('h2');heading.textContent='Authorize Apple TV';dialog.append(heading);
      const requestID=document.createElement('input');requestID.placeholder='Request ID shown by Apple TV';requestID.maxLength=160;requestID.setAttribute('aria-label','Apple TV request ID');
      const hash=location.hash.match(/^#pair-tv=([\w-]{16,160})$/);if(hash)requestID.value=hash[1];dialog.append(requestID);
      const details=document.createElement('p');dialog.append(details);
      const inspect=document.createElement('button');inspect.textContent='Check request';dialog.append(inspect);
      const code=document.createElement('input');code.placeholder='Code displayed by Apple TV';code.maxLength=32;code.setAttribute('aria-label','Code displayed by Apple TV');dialog.append(code);
      const approve=document.createElement('button');approve.textContent='Approve Apple TV';approve.disabled=true;dialog.append(approve);
      let reviewed=null;
      requestID.oninput=()=>{reviewed=null;approve.disabled=true;};
      inspect.onclick=async()=>{reviewed=null;approve.disabled=true;const id=requestID.value.trim();if(!/^[\w-]{16,160}$/.test(id)){details.textContent='Enter a valid request ID.';return;}try{const r=await request('device-pairings/'+id);const j=await r.json();if(!r.ok||j.status!=='waiting')throw Error(j.error||'Request unavailable.');if(requestID.value.trim()!==id)return;reviewed=id;details.textContent=(j.deviceName||'Apple TV')+' — '+(j.deviceModel||'')+'. Confirm that this is your TV, then type the code displayed on it.';approve.disabled=false;}catch(error){details.textContent=error.message;}};
      approve.onclick=async()=>{if(!reviewed||reviewed!==requestID.value.trim())return;approve.disabled=true;try{const r=await request('device-pairings/'+reviewed+'/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verificationCode:code.value.trim()})});const j=await r.json();if(!r.ok)throw Error(j.error||'Approval failed.');details.textContent='Apple TV approved. It receives its own controller credential.';code.value='';reviewed=null;}catch(error){details.textContent=error.message;approve.disabled=false;}};
      const close=document.createElement('button');close.textContent='Close';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(close);document.body.append(dialog);dialog.showModal();if(hash)inspect.onclick();
    };
    if(/^#pair-tv=[\w-]{16,160}$/.test(location.hash))tv.onclick();
    const button=document.createElement('button');button.textContent='Pair a browser';addAction(button);
    const logout=document.createElement('button');logout.textContent='Sign out';addAction(logout);
    logout.onclick=async()=>{logout.disabled=true;try{const r=await request('logout',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error||'Sign-out failed.');if(j.warning)alert(j.warning);try{window.top.location.reload();}catch{location.reload();}}catch(error){logout.textContent=error.message;logout.disabled=false;}};
    if(auth.role==='administrator'){
      const devices=document.createElement('button');devices.textContent='Manage devices';addAction(devices);
      devices.onclick=async()=>{
        const dialog=document.createElement('dialog');dialog.style.cssText='max-width:520px;background:#142235;color:white;padding:24px;border-radius:12px';
        const title=document.createElement('h2');title.textContent='Authorized Sonuvi devices';dialog.append(title);
        const rows=document.createElement('div');dialog.append(rows);
        const close=document.createElement('button');close.textContent='Close';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(close);document.body.append(dialog);dialog.showModal();
        const load=async()=>{rows.replaceChildren();try{const response=await request('devices');const result=await response.json();if(!response.ok)throw Error(result.error||'Device management unavailable.');for(const item of result.devices||[]){const row=document.createElement('p');const label=document.createElement('span');label.textContent=(item.label||'Sonuvi device')+' — '+item.role+' — '+item.status+' ';row.append(label);if(item.status==='active'){const revoke=document.createElement('button');revoke.textContent='Revoke access';revoke.onclick=async()=>{if(!confirm('Revoke access for '+(item.label||'this device')+'?'))return;revoke.disabled=true;try{const r=await request('devices/'+encodeURIComponent(item.deviceId),{method:'DELETE'});if(!r.ok)throw Error('Revocation was not confirmed.');await load();}catch(error){revoke.textContent=error.message;revoke.disabled=false;}};row.append(revoke);}rows.append(row);}}catch(error){rows.textContent=error.message;}};
        await load();
      };
    }
    button.onclick=async()=>{
      const dialog=document.createElement('dialog');dialog.style.cssText='max-width:520px;color:inherit;background:#142235;color:white;border:1px solid #65758a;border-radius:12px;padding:24px';
      const heading=document.createElement('h2');heading.textContent='Approve a new browser';dialog.append(heading);
      const note=document.createElement('p');note.textContent='Start pairing in the new browser, then enter its displayed code below. Approve only a browser you recognize.';dialog.append(note);
      const rows=document.createElement('div');dialog.append(rows);
      const refresh=document.createElement('button');refresh.textContent='Refresh requests';dialog.append(refresh);
      const close=document.createElement('button');close.textContent='Close';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(close);document.body.append(dialog);dialog.showModal();
      const load=async()=>{
        rows.replaceChildren();
        try{const r=await request('pairings/pending');const j=await r.json();if(!r.ok)throw Error('Pairing session expired. Reload this browser.');
          if(!j.items.length){const p=document.createElement('p');p.textContent='No browsers waiting. Start pairing on the new browser, then refresh.';rows.append(p);}
          for(const item of j.items){const form=document.createElement('form');const label=document.createElement('p');label.textContent=item.label;form.append(label);const input=document.createElement('input');input.placeholder='Code from the new browser';input.setAttribute('aria-label','Verification code');input.autocomplete='off';input.required=true;form.append(input);const approve=document.createElement('button');approve.textContent='Approve browser';form.append(approve);const status=document.createElement('p');form.append(status);form.onsubmit=async event=>{event.preventDefault();approve.disabled=true;try{const response=await request('pairings/'+encodeURIComponent(item.presentationId)+'/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verificationCode:input.value.trim()})});const result=await response.json();status.textContent=response.ok?'Browser approved. It will open automatically.':result.error||'Approval failed.';}catch{status.textContent='Connection lost. Refresh and retry.';}finally{approve.disabled=false;}};rows.append(form);}
        }catch(error){rows.textContent=error.message;}
      };refresh.onclick=load;await load();
    };
  }
  async function checkSession(){
    try{
      const r=await request('session');let j={};try{j=await r.json();}catch{}
      if(r.ok&&j.authenticated){
        auth.csrfToken=j.csrfToken;
        auth.role=j.role==='administrator'?'administrator':'controller';
        if(!readyResolved){readyResolved=true;complete(true);}
        document.getElementById('sonuviBrowserPairing')?.remove();
        browserApproval();return;
      }
      if(r.status>=500){transientSessionFailure(j.error||'Controller service is temporarily unavailable. Retry the connection; do not pair again unless this browser grant was revoked or browser data was cleared.');return;}
      const box=overlay();box.querySelector('#sonuviLoginForm').style.display='block';box.querySelector('#sonuviPairStart').style.display='inline-block';box.querySelector('#sonuviSessionRetry').style.display='none';box.querySelector('#sonuviPairStatus').textContent=j.error||'Enter your Sonuvi username and password. QR scanning is optional.';
    }catch{transientSessionFailure('Controller service is temporarily unavailable. Retry the connection; do not pair again unless this browser grant was revoked or browser data was cleared.');}
  }
  document.addEventListener('DOMContentLoaded',checkSession);
})();
