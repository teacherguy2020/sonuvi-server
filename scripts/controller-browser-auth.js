/* Same-origin controller pairing. Only HttpOnly cookies cross the browser boundary. */
(() => {
  if (!globalThis.SonuviControllerWeb) return;
  let complete;
  const ready = new Promise(resolve => { complete = resolve; });
  const auth = globalThis.SonuviControllerAuth = { ready, enabled: true, csrfToken: '' };
  let timer;
  const request = (path,options={}) => fetch('/__controller/'+path,{credentials:'same-origin',cache:'no-store',...options});
  function overlay() {
    let box=document.getElementById('sonuviBrowserPairing');if(box)return box;
    box=document.createElement('section');box.id='sonuviBrowserPairing';box.style.cssText='position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:#07101df2;color:white;font:16px system-ui;text-align:center';
    box.innerHTML='<div style="max-width:400px"><h2>Pair this controller</h2><p id="sonuviPairStatus">Checking secure access…</p><img id="sonuviPairQr" alt="Pairing QR code" style="display:none;width:260px"><p id="sonuviPairCode"></p><button id="sonuviPairStart">Start trusted-device pairing</button><p>Scan with an already trusted Sonuvi controller and compare the verification code before approving.</p></div>';
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
      status.textContent='Scan and compare this code on your trusted controller.';poll(j.presentationId);
    }catch(error){status.textContent=error.message;}
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    try{const r=await request('session'),j=await r.json();if(r.ok&&j.authenticated){auth.csrfToken=j.csrfToken;complete(true);return;}overlay().querySelector('#sonuviPairStatus').textContent=j.error||'Trusted-device approval is required.';}
    catch{overlay().querySelector('#sonuviPairStatus').textContent='Controller service unavailable.';}
  });
})();
