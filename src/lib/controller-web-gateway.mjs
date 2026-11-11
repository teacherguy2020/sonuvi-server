import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import QRCode from 'qrcode';
import { reversePairingProofMessage } from './mobile-pairing.mjs';
import { controllerDispatchHeader, isControllerDispatchable, validControllerTarget, validControllerBody, isLoopbackAddress } from './controller-browser-dispatch.mjs';
const HOURS = 8 * 60 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString('base64url');
const cookie = (req,name) => String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1) || '';
const equal = (a,b) => {const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const setCookie = (name,value,secure,age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure?'; Secure':''}; Max-Age=${age}`;
const send = (res,status,body,headers={}) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify(body));};
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('JSON body required');
  const chunks=[];let size=0;for await (const chunk of req) {size+=chunk.length;if(size>65536)throw new Error('body too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const mobileRead = path => path === '/v1/mobile/animated-art' || /^\/v1\/mobile\/animated-art\/media\/[a-f0-9]{40}\.mp4$/.test(path);

/** Browser cookies grant only the explicitly listed ordinary controller operations. */
export function createControllerWebGateway({ secret=process.env.SONUVI_CONTROLLER_WEB_SECRET, origin=process.env.SONUVI_CONTROLLER_WEB_ORIGIN, apiPort=Number(process.env.SONUVI_CONTROLLER_API_PORT||3101), allowLoopbackFixture=false, trustLoopbackProxy=process.env.SONUVI_CONTROLLER_TRUST_LOOPBACK_PROXY==='1', sessionFile=process.env.SONUVI_CONTROLLER_SESSION_FILE }={}) {
  let configured='';
  if(origin) {const u=new URL(origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('controller origin must be an HTTPS origin');configured=u.origin;}
  if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('invalid loopback API port');
  const sessions=new Map(),pairings=new Map();
  if(sessionFile){
    if(!path.isAbsolute(sessionFile))throw new Error('browser session path must be absolute');
    const parent=fs.lstatSync(path.dirname(sessionFile));
    if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())throw new Error('browser sessions require a private service-owned directory');
    if(fs.existsSync(sessionFile)){
      const stat=fs.lstatSync(sessionFile);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.()||stat.size>2*1024*1024)throw new Error('unsafe browser session file');
      const saved=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
      if(saved.origin!==configured||!Array.isArray(saved.sessions)||saved.sessions.length>512)throw new Error('browser session identity mismatch');
      for(const [id,entry] of saved.sessions)if(/^[\w-]{43}$/.test(id)&&entry.expiresAt>Date.now()&&entry.expiresAt<=Date.now()+HOURS&&typeof entry.accessToken==='string'&&typeof entry.csrf==='string')sessions.set(id,entry);
    }
  }
  const persist=()=>{
    if(!sessionFile)return;
    const temporary=sessionFile+'.'+random()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify({origin:configured,sessions:[...sessions]}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,sessionFile);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  };
  const prune=()=>{for(const map of [sessions,pairings])for(const [id,s] of map)if(s.expiresAt<=Date.now())map.delete(id);};
  const api=async(method,target,{headers={},body,dispatch=false}={})=>fetch(`http://127.0.0.1:${apiPort}${target}`,{method,headers:{...(dispatch?{'x-sonuvi-controller-dispatch':controllerDispatchHeader({secret,method,target})}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  return async(req,res)=>{
    let url;try{url=new URL(req.url,'http://web.invalid');}catch{send(res,400,{ok:false});return true;}
    const legacy=isControllerDispatchable({method:req.method,pathname:url.pathname});
    const mobile=req.method==='GET'&&mobileRead(url.pathname);
    if(!url.pathname.startsWith('/__controller/')&&!legacy&&!mobile)return false;
    prune();
    const local=isLoopbackAddress(req.socket.remoteAddress);
    const fixture=allowLoopbackFixture&&local&&/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host||'');
    const secure=req.socket.encrypted===true||(trustLoopbackProxy&&local&&req.headers['x-forwarded-proto']==='https');
    const expected=configured||(fixture?`http://${req.headers.host}`:'');
    if(!expected||(!secure&&!fixture)){send(res,503,{ok:false,error:'Browser pairing requires configured HTTPS transport.'});return true;}
    if(new URL(expected).host!==req.headers.host||(req.headers.origin&&req.headers.origin!==expected)||(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==expected)||req.headers['sec-fetch-site']==='cross-site'){send(res,403,{ok:false,error:'Controller origin or Host rejected.'});return true;}
    const id=cookie(req,'sonuvi_controller'),session=sessions.get(id);
    try {
      if(url.pathname==='/__controller/session'&&req.method==='GET'){send(res,200,{ok:true,authenticated:!!session,csrfToken:session?.csrf||null,expiresAt:session?.expiresAt||null});return true;}
      if(url.pathname==='/__controller/pairings'&&req.method==='POST'){
        if(pairings.size>=128||sessions.size>=512){send(res,429,{ok:false,error:'Controller capacity reached.'});return true;}
        const up=await api('POST','/v1/mobile/pairing/presentations');const p=await up.json();
        if(!up.ok||!p.presentationId||!p.pollToken)throw new Error('pairing unavailable');
        const device={deviceId:'browser-'+crypto.randomUUID(),deviceName:'Sonuvi browser controller',deviceModel:'Web browser'};
        const keys=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
        const message=reversePairingProofMessage({...device,presentationId:p.presentationId,challenge:p.challenge});
        const attestation=await api('POST',`/v1/mobile/pairing/presentations/${encodeURIComponent(p.presentationId)}/attest`,{body:{...device,publicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64url'),signature:crypto.sign('sha256',Buffer.from(message),keys.privateKey).toString('base64url'),signatureAlgorithm:'ecdsa-p256-sha256'}});
        const proof=await attestation.json();if(!attestation.ok||proof.status!=='waiting')throw new Error('pairing attestation failed');
        const nonce=random();const expiresAt=Number(p.expiresAt)||Date.parse(p.expiresAt);
        if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('invalid pairing expiry');
        pairings.set(p.presentationId,{pollToken:p.pollToken,nonce,expiresAt,deviceId:device.deviceId,label:String(req.headers['user-agent']||'New browser').replace(/[\x00-\x1f]/g,'').slice(0,160),createdAt:Date.now()});
        const qrPayload={protocol:'now-playing-mobile-reverse-pairing',version:1,baseUrl:p.baseUrl,presentationId:p.presentationId,challenge:p.challenge};
        send(res,201,{ok:true,presentationId:p.presentationId,expiresAt,verificationCode:proof.verificationCode,qrPayload,qrDataUrl:await QRCode.toDataURL(JSON.stringify(qrPayload),{margin:1,width:360})},{'set-cookie':setCookie('sonuvi_controller_pairing',nonce,secure,120)});return true;
      }
      if(url.pathname==='/__controller/pairings/pending'&&req.method==='GET'){
        if(!session){send(res,401,{ok:false,error:'Controller pairing required.'});return true;}
        send(res,200,{ok:true,items:[...pairings].map(([presentationId,p])=>({presentationId,label:p.label,createdAt:p.createdAt,expiresAt:p.expiresAt}))});return true;
      }
      const approval=url.pathname.match(/^\/__controller\/pairings\/([\w-]+)\/approve$/);
      if(approval&&req.method==='POST'){
        if(!session||!equal(session.csrf,req.headers['x-csrf-token'])){send(res,403,{ok:false,error:'CSRF validation failed.'});return true;}
        if(!pairings.has(approval[1])){send(res,404,{ok:false,error:'Pairing expired.'});return true;}
        let body;try{body=await readJson(req);}catch{send(res,400,{ok:false,error:'Invalid approval.'});return true;}
        if(typeof body.verificationCode!=='string'||body.verificationCode.length>32||Object.keys(body).some(k=>k!=='verificationCode')){send(res,400,{ok:false,error:'Invalid verification code.'});return true;}
        const up=await api('POST',`/v1/mobile/pairing/presentations/${approval[1]}/approve`,{headers:{authorization:`Bearer ${session.accessToken}`},body:{verificationCode:body.verificationCode}});
        send(res,up.status,{ok:up.ok,...(!up.ok?{error:'Code did not match or approval expired.'}:{})});return true;
      }
      const match=url.pathname.match(/^\/__controller\/pairings\/([\w-]+)\/complete$/);
      if(match&&req.method==='GET'){
        const p=pairings.get(match[1]);if(!p||!equal(p.nonce,cookie(req,'sonuvi_controller_pairing'))){send(res,401,{ok:false,error:'Pairing expired.'});return true;}
        const up=await api('GET',`/v1/mobile/pairing/presentations/${match[1]}/complete`,{headers:{'x-mobile-pairing-poll-token':p.pollToken}});const body=await up.json();
        if(!up.ok||body.status!=='approved'){send(res,up.status,{ok:up.ok,status:body.status||'waiting'});return true;}
        if(body.deviceId!==p.deviceId||!body.accessToken)throw new Error('pairing grant mismatch');
        const tokenExpiry=Number(body.expiresAt)||Date.parse(body.expiresAt);const expiresAt=Math.min(Date.now()+HOURS,tokenExpiry);
        if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('invalid session expiry');
        pairings.delete(match[1]);const sessionId=random(),csrf=random();sessions.set(sessionId,{csrf,expiresAt,accessToken:body.accessToken});persist();
        send(res,200,{ok:true,status:'approved',csrfToken:csrf,expiresAt},{'set-cookie':[setCookie('sonuvi_controller',sessionId,secure,Math.floor((expiresAt-Date.now())/1000)),setCookie('sonuvi_controller_pairing','',secure,0)]});return true;
      }
      if(['/__controller/logout','/__controller/refresh'].includes(url.pathname)&&req.method==='POST'){
        if(!session||!equal(session.csrf,req.headers['x-csrf-token'])){send(res,403,{ok:false,error:'CSRF validation failed.'});return true;}
        // Refresh is cookie renewal only: it cannot extend the original grant.
        if(url.pathname.endsWith('/logout')){sessions.delete(id);persist();send(res,200,{ok:true},{'set-cookie':setCookie('sonuvi_controller','',secure,0)});}
        else send(res,200,{ok:true,expiresAt:session.expiresAt},{'set-cookie':setCookie('sonuvi_controller',id,secure,Math.floor((session.expiresAt-Date.now())/1000))});return true;
      }
      if(legacy||mobile){
        if(!session){send(res,401,{ok:false,error:'Controller pairing required.'});return true;}
        if(legacy&&!validControllerTarget(url.pathname+url.search,req.method)){send(res,400,{ok:false,error:'Controller query rejected.'});return true;}
        let body;
        if(req.method==='POST'){
          if(!equal(session.csrf,req.headers['x-csrf-token'])){send(res,403,{ok:false,error:'CSRF validation failed.'});return true;}
          try{body=await readJson(req);}catch{send(res,400,{ok:false,error:'Invalid controller body.'});return true;}
          if(!validControllerBody({method:req.method,pathname:url.pathname,body})){send(res,400,{ok:false,error:'Controller body rejected.'});return true;}
        }
        const headers={authorization:`Bearer ${session.accessToken}`, ...(legacy?{'x-sonuvi-controller-dispatch':'mobile-session'}:{})};
        if(req.headers.range)headers.range=req.headers.range;
        const up=await api(req.method,url.pathname+url.search,{headers,body});
        const out={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
        for(const h of ['content-type','content-length','content-range','accept-ranges'])if(up.headers.has(h))out[h]=up.headers.get(h);
        // Re-home authenticated animation URLs to the cookie-protected web origin.
        if(url.pathname==='/v1/mobile/animated-art'&&up.ok){const body=await up.json();if(body.mediaUrl){const media=new URL(body.mediaUrl);if(/^\/v1\/mobile\/animated-art\/media\//.test(media.pathname))body.mediaUrl=expected+media.pathname; }send(res,up.status,body);return true;}
        res.writeHead(up.status,out);if(up.body)await pipeline(Readable.fromWeb(up.body),res);else res.end();return true;
      }
      send(res,404,{ok:false,error:'Unknown controller route.'});return true;
    }catch(error){if(!res.headersSent)send(res,502,{ok:false,error:'Controller upstream request failed.'});else res.destroy();return true;}
  };
}
