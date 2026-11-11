import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { controllerDispatchHeader, isControllerDispatchable } from './controller-browser-dispatch.mjs';
const HOURS = 8 * 60 * 60 * 1000;
const text = (v) => String(v || '').trim();
const random = () => crypto.randomBytes(32).toString('base64url');
const loopback = (h) => /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(text(h));
const getCookie = (r,n) => text(r.headers.cookie).split(';').map((x)=>x.trim()).find((x)=>x.startsWith(n+'='))?.slice(n.length+1)||'';
const equal = (a,b) => { const x=Buffer.from(String(a)),y=Buffer.from(String(b)); return x.length===y.length&&crypto.timingSafeEqual(x,y); };
const setCookie = (n,v,s,age) => n+'='+v+'; Path=/; HttpOnly; SameSite=Strict'+(s?'; Secure':'')+'; Max-Age='+age;
const send = (r,s,b,h={}) => { r.writeHead(s,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...h});r.end(JSON.stringify(b)); };
/** Browser sessions never contain a Track Key; API receives only a signed loopback capability. */
export function createControllerWebGateway({ secret=process.env.SONUVI_CONTROLLER_WEB_SECRET, origin=process.env.SONUVI_CONTROLLER_WEB_ORIGIN, apiPort=Number(process.env.SONUVI_CONTROLLER_API_PORT||3101), allowLoopbackFixture=process.env.SONUVI_CONTROLLER_ALLOW_LOOPBACK_FIXTURE==='1', trustLoopbackProxy=process.env.SONUVI_CONTROLLER_TRUST_LOOPBACK_PROXY==='1' }={}) {
 const key=text(secret), configured=text(origin).replace(/\/$/,''); const sessions=new Map(), pairings=new Map();
 const sourceLocal=(r)=>String(r.socket.remoteAddress)==='127.0.0.1'||String(r.socket.remoteAddress)==='::1'||String(r.socket.remoteAddress)==='::ffff:127.0.0.1';
 const local=(r)=>loopback(r.headers.host)&&sourceLocal(r);
 const secured=(r)=>r.socket.encrypted===true||(trustLoopbackProxy&&sourceLocal(r)&&text(r.headers['x-forwarded-proto']).toLowerCase()==='https');
 const expected=(r,s)=>configured||(allowLoopbackFixture&&local(r)?(s?'https':'http')+'://'+r.headers.host:'');
 const ready=(r,s)=>Boolean(key&&(configured.startsWith('https://')||(allowLoopbackFixture&&local(r)&&!s)));
 const originValid=(r,s)=>{const wanted=expected(r,s), supplied=text(r.headers.origin); if(supplied)return supplied===wanted; try{return r.method==='GET'&&new URL(wanted).host===text(r.headers.host);}catch{return false;}};
 const session=(r)=>{const id=getCookie(r,'sonuvi_controller'),v=sessions.get(id);if(!v||v.expiresAt<Date.now()){sessions.delete(id);return null;}return {id,...v};};
 const api=(method,pathname,headers={})=>fetch('http://127.0.0.1:'+apiPort+pathname,{method,headers:{'x-sonuvi-controller-dispatch':controllerDispatchHeader({secret:key,method,pathname:pathname.split('?',1)[0]}),...headers},redirect:'error'});
 return async (req,res)=>{const url=new URL(req.url||'/','http://web.invalid'),secure=secured(req), controlled=url.pathname.startsWith('/__controller/')||isControllerDispatchable({method:req.method,pathname:url.pathname});if(!controlled)return false;
  if(!ready(req,secure)){send(res,503,{ok:false,error:'Browser controller pairing requires a configured HTTPS origin. HTTP LAN browser authentication is intentionally disabled.'});return true;}
  if(!originValid(req,secure)){send(res,403,{ok:false,error:'Controller request origin was rejected.'});return true;}
  if(url.pathname==='/__controller/session'&&req.method==='GET'){const s=session(req);send(res,200,{ok:true,authenticated:Boolean(s),expiresAt:s?.expiresAt||null,csrfToken:s?.csrf||null});return true;}
  if(url.pathname==='/__controller/pairings'&&req.method==='POST'){const up=await api('POST','/v1/mobile/pairing/presentations'),p=await up.json().catch(()=>({}));if(!up.ok){send(res,up.status,{ok:false,error:'Trusted-controller pairing is unavailable.'});return true;}const nonce=random();pairings.set(p.presentationId,{pollToken:p.pollToken,nonce,expiresAt:Date.parse(p.expiresAt)||Date.now()+90000});const qrPayload={protocol:'now-playing-mobile-reverse-pairing',version:1,baseUrl:p.baseUrl,presentationId:p.presentationId,challenge:p.challenge};send(res,201,{ok:true,presentationId:p.presentationId,expiresAt:p.expiresAt,qrPayload,qrDataUrl:await QRCode.toDataURL(JSON.stringify(qrPayload),{margin:1,width:360})},{'set-cookie':setCookie('sonuvi_controller_pairing',nonce,secure,120)});return true;}
  const match=url.pathname.match(/^\/__controller\/pairings\/([^/]+)\/complete$/);if(match&&req.method==='GET'){const p=pairings.get(match[1]);if(!p||p.expiresAt<Date.now()||!equal(p.nonce,getCookie(req,'sonuvi_controller_pairing'))){send(res,401,{ok:false,error:'Pairing session expired.'});return true;}const path='/v1/mobile/pairing/presentations/'+encodeURIComponent(match[1])+'/complete',up=await api('GET',path,{'x-mobile-pairing-poll-token':p.pollToken}),body=await up.json().catch(()=>({}));if(body.status!=='approved'){send(res,up.status,{ok:up.ok,status:body.status||'waiting',expiresAt:body.expiresAt||null});return true;}pairings.delete(match[1]);const id=random(),csrf=random(),expiresAt=Date.now()+HOURS;sessions.set(id,{csrf,expiresAt});send(res,200,{ok:true,status:'approved',csrfToken:csrf,expiresAt},{'set-cookie':[setCookie('sonuvi_controller',id,secure,HOURS/1000),setCookie('sonuvi_controller_pairing','',secure,1)]});return true;}
  if(url.pathname==='/__controller/refresh'&&req.method==='POST'){const s=session(req);if(!s||!equal(s.csrf,req.headers['x-csrf-token'])){send(res,403,{ok:false,error:'CSRF validation failed.'});return true;}s.expiresAt=Date.now()+HOURS;sessions.set(s.id,s);send(res,200,{ok:true,expiresAt:s.expiresAt},{'set-cookie':setCookie('sonuvi_controller',s.id,secure,HOURS/1000)});return true;}
  if(url.pathname==='/__controller/logout'&&req.method==='POST'){const s=session(req);if(!s||!equal(s.csrf,req.headers['x-csrf-token'])){send(res,403,{ok:false,error:'CSRF validation failed.'});return true;}sessions.delete(s.id);send(res,200,{ok:true},{'set-cookie':setCookie('sonuvi_controller','',secure,1)});return true;}
  if(isControllerDispatchable({method:req.method,pathname:url.pathname})){if(!session(req)){send(res,401,{ok:false,error:'Controller pairing is required.'});return true;}const up=await api(req.method,url.pathname+url.search);res.writeHead(up.status,{'content-type':up.headers.get('content-type')||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(Buffer.from(await up.arrayBuffer()));return true;}
  send(res,404,{ok:false,error:'Unknown controller route.'});return true;
 };
}
