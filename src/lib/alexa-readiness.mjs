import fs from 'node:fs/promises';
import https from 'node:https';
import { lookup } from 'node:dns/promises';

export const alexaSetupGuidance = 'Saving the public domain does not provision a public certificate or router forwarding. Alexa requires publicly trusted HTTPS for this hostname, API and audio routes, and a matching Lambda TRACK_KEY. Keep sonuvi.local for local access; do not forward its private-certificate browser listener. A restart alone does not complete this setup.';
export function alexaHostname(value) {
  const host=String(value||'').trim().toLowerCase();
  return host.length<=253 && host.includes('.') && !host.endsWith('.local') && !host.endsWith('.localhost') && !/^\d+(?:\.\d+){3}$/.test(host) && host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : null;
}
// Public IPv4 only: never probe local services, metadata endpoints, or special-use networks.
export function publicIPv4(address) {
 const a=address.split('.').map(Number);
 return a.length===4 && a.every(n=>Number.isInteger(n)&&n>=0&&n<=255) && ![0,10,127].includes(a[0]) && a[0]<224 && !(a[0]===100&&a[1]>=64&&a[1]<=127) && !(a[0]===169&&a[1]===254) && !(a[0]===172&&a[1]>=16&&a[1]<=31) && !(a[0]===192&&(a[1]===168||a[1]===0||a[1]===2)) && !(a[0]===198&&(a[1]===18||a[1]===19||a[1]===51)) && !(a[0]===203&&a[1]===0&&a[2]===113);
}
export function alexaSetupStatus(settings, endpoint) {
 const configured=Boolean(alexaHostname(settings.publicDomain));
 return {enabled:settings.enabled,configured,operational:null,setupState:!settings.enabled?'disabled':!configured?'domain-required':endpoint?.state||'not-checked',
  endpoint:endpoint||null,guidance:alexaSetupGuidance,
  error:!settings.enabled?null:!configured?'Enter a public DNS hostname without a scheme, path, or port.':endpoint?.message||'Public HTTPS has not been verified. Saved settings do not mean Alexa is ready.'};
}
export function createAlexaReadiness({resolve=lookup,request=https.request,timeoutMs=6500,now=()=>Date.now()}={}) {
 const cache=new Map(),pending=new Map();
 const status=settings=>alexaSetupStatus(settings,cache.get(settings.publicDomain)?.expires>now()?cache.get(settings.publicDomain).value:undefined);
 const check=async settings=>{
  const host=alexaHostname(settings.publicDomain);
  if(!host||!settings.enabled)return status(settings);
  if(pending.has(host))return pending.get(host);
  const run=(async()=>{
   let timer,req,expired=false;
   const result=(state,message)=>({state,message,checkedAt:new Date(now()).toISOString(),hostname:host,scope:'server-origin HTTPS/API probe; not an external Alexa playback test'});
   let value;
   try {
    value=await Promise.race([
     new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Object.assign(new Error(),{code:'ETIMEDOUT'}));},timeoutMs);}),
     (async()=>{
      const addresses=await resolve(host,{all:true,family:4});
      if(expired)throw Object.assign(new Error(),{code:'ETIMEDOUT'});
      if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))return result('public-dns-required','The hostname must resolve to a public IPv4 address for this check. Private and special-use addresses are not probed.');
      return await new Promise((resolve,reject)=>{
       req=request({hostname:host,servername:host,port:443,path:'/now-playing',method:'GET',rejectUnauthorized:true,headers:{Accept:'application/json'},lookup:(_host,options,callback)=>callback(null,...(options.all?[[addresses[0]]]:[addresses[0].address,4]))},res=>{
        let data='';res.setEncoding('utf8');res.on('error',reject);
        res.on('data',chunk=>{data+=chunk;if(data.length>65536){req.destroy();resolve(result('route-invalid','The public endpoint did not return the expected Sonuvi API response.'));}});
        res.on('end',()=>{
         if(res.statusCode!==200)return resolve(result('route-invalid',`Public HTTPS answered HTTP ${res.statusCode}. Verify the public API route and authentication; redirects are not followed.`));
         try {const body=JSON.parse(data);if(!body||typeof body!=='object'||Array.isArray(body)||!('state' in body||'file' in body))throw Error();}
         catch{return resolve(result('route-invalid','HTTPS works, but /now-playing is not the expected Sonuvi JSON response. Check API routing.'));}
         resolve(result('endpoint-reachable','Public HTTPS and /now-playing respond from this Server. Lambda authorization, audio delivery, and external reachability still require an Alexa playback test.'));
        });
       });req.on('error',reject);req.end();
      });
     })()
    ]);
   } catch(error){
    const code=String(error.code||'');
    value=/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)?result('certificate-invalid','The public hostname does not present a trusted, matching HTTPS certificate. The private sonuvi.local certificate cannot be used by Alexa.'):
      /ENOTFOUND|EAI_AGAIN/.test(code)?result('dns-failed','Public DNS could not be resolved. Check the hostname and DNS record.'):
      result('connection-failed','Public HTTPS could not be reached. Check the public listener, firewall, and router forwarding. A Server-side probe can also fail if the router does not support NAT loopback.');
   }finally{clearTimeout(timer);req?.destroy();}
   cache.set(settings.publicDomain,{value,expires:now()+60000});return alexaSetupStatus(settings,value);
  })();pending.set(host,run);try{return await run;}finally{pending.delete(host);}
 };
 const provisioning=async()=>{
  try{
   const saved=JSON.parse(await fs.readFile('/var/lib/sonuvi/config/alexa-public-https-status.json','utf8'));
   if(saved.managed!==true)return null;
   return {managed:true,state:['disabled','configuration-error','awaiting-public-verification'].includes(saved.state)?saved.state:'unknown',internalPort:9443,externalPort:443};
  }catch{return null;}
 };
 return {status,check,provisioning};
}
