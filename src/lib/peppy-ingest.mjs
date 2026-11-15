import fs from 'node:fs/promises';
import crypto from 'node:crypto';

// Dedicated machine credential: never accepts browser cookies or arbitrary targets.
export function createPeppyIngest({tokenFile=process.env.SONUVI_PEPPY_TOKEN_FILE,apiPort=3101}={}) {
  return async (req,res) => {
    const targets=new Map([['/__peppy/vumeter','/peppy/vumeter'],['/__peppy/spectrum','/peppy/spectrum']]);
    const target=targets.get(req.url);if(!target)return false;
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(req.method!=='PUT'){send(405,{ok:false});return true;}
    let token='';try{token=(await fs.readFile(tokenFile,'utf8')).trim();}catch{}
    const supplied=String(req.headers.authorization||'');
    const hash=s=>crypto.createHash('sha256').update(s).digest();
    if(token.length<32||!crypto.timingSafeEqual(hash(supplied),hash('Bearer '+token))){send(401,{ok:false});return true;}
    try {
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){send(413,{ok:false});return true;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
      const valid=body&&typeof body==='object'&&!Array.isArray(body)&&(target.endsWith('vumeter')
        ?Object.keys(body).every(k=>['left','right','mono'].includes(k))&&['left','right','mono'].every(k=>number(body[k]))
        :Object.keys(body).every(k=>['bins','size','maxValue'].includes(k))&&Array.isArray(body.bins)&&body.bins.length>0&&body.bins.length<=256&&body.bins.every(number)&&(body.size===undefined||body.size===body.bins.length)&&(body.maxValue===undefined||body.maxValue===100));
      if(!valid){send(400,{ok:false});return true;}
      const up=await fetch(`http://127.0.0.1:${apiPort}${target}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(2000)});
      send(up.ok?200:502,{ok:up.ok});
    }catch{send(400,{ok:false});}
    return true;
  };
}
