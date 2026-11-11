/* Same-origin controller pairing. Only HttpOnly cookies cross the browser boundary. */
(() => {
  if (!globalThis.SonuviControllerWeb) return;
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const auth = globalThis.SonuviControllerAuth = { ready, enabled: true, csrfToken: '' };
  let timer;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function(input, options = {}) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if(target.origin === location.origin && /^\/(?:config\/|recent\/|art\/|v1\/mobile\/|now-playing(?:\?|$)|next-up(?:\?|$)|podcasts(?:\?|$))/.test(target.pathname)) await ready;
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (target.origin === location.origin && !['GET','HEAD','OPTIONS'].includes(method) && auth.csrfToken) {
      const headers = new Headers(options.headers || input?.headers);headers.set('x-csrf-token',auth.csrfToken);options={...options,headers};
    }
    return nativeFetch(input,options);
  };
  const request = (path,options={}) => fetch('/__controller/'+path,{credentials:'same-origin',cache:'no-store',...options});
  function overlay() {
    let box=document.getElementById('sonuviBrowserPairing');if(box)return box;
    box=document.createElement('section');box.id='sonuviBrowserPairing';box.style.cssText='position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#07101df2;color:white;font:16px system-ui;text-align:center';
    box.innerHTML='<div style="max-width:400px"><h2>Pair this controller</h2><p id="sonuviPairStatus">Checking secure access…</p><img id="sonuviPairQr" alt="Pairing QR code" style="display:none;width:260px"><p id="sonuviPairCode"></p><button id="sonuviPairStart">Start trusted-device pairing</button><p>On an already paired browser, choose “Pair a browser” and enter the code shown here. You can also scan with a compatible trusted Sonuvi controller.</p></div>';
    document.body.append(box);box.querySelector('button').onclick=start;return box;
  }
  async function poll(id) {
    try {
      const r=await request('pairings/'+encodeURIComponent(id)+'/complete');const j=await r.json();
      if(r.ok&&j.status==='approved'){location.reload();return;}
      if(!r.ok||['expired','rejected','cancelled','completed'].includes(j.status)){overlay().querySelector('#sonuviPairStatus').textContent=j.error||'Pairing ended. Start again.';return;}
      timer=setTimeout(()=>poll(id),1000);
    }catch{overlay().querySelector('#sonuviPairStatus').textContent='Connection lost. Start pairing again.';}
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
    if(window.top!==window.self)return;
    const button=document.createElement('button');button.textContent='Pair a browser';button.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;padding:8px 12px;border-radius:8px';document.body.append(button);
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
  document.addEventListener('DOMContentLoaded',async()=>{
    try{const r=await request('session'),j=await r.json();if(r.ok&&j.authenticated){auth.csrfToken=j.csrfToken;complete(true);browserApproval();return;}overlay().querySelector('#sonuviPairStatus').textContent=j.error||'Trusted-device approval is required.';}
    catch{overlay().querySelector('#sonuviPairStatus').textContent='Controller service unavailable.';}
  });
})();
