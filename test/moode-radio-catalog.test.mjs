import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { readMoodeRadioCatalog, filterRadioCatalog } from '../src/lib/moode-radio-catalog.mjs';
import { registerConfigQueueWizardBasicRoutes } from '../src/routes/config.queue-wizard-basic.routes.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { registerConfigBrowseRoutes } from '../src/routes/config.browse.routes.mjs';
import { createMobileSessionToken, createMobileTrackId } from '../src/lib/mobile-auth.mjs';
import { radioDisplayName } from '../src/lib/radio-display.mjs';
import { radioCatalogFixture } from './fixtures/moode-radio-catalog.mjs';

const rows = radioCatalogFixture();
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const unavailable = e => e.code === 'RADIO_CATALOG_UNAVAILABLE' && !e.message.includes('private');

function appFixture() {
  const routes = new Map();
  return { routes, get: (p,h)=>routes.set('GET '+p,h), post: (p,h)=>routes.set('POST '+p,h), delete: (p,h)=>routes.set('DELETE '+p,h) };
}
function response() {
  return { statusCode:200, headers:{}, status(c){this.statusCode=c;return this}, json(v){this.body=v;return this}, set(k,v){this.headers[k]=v;return this}, setHeader(k,v){this.headers[k]=v}, end(){return this} };
}
function request(extra={}) {
  return { headers:{}, query:{}, body:{}, params:{}, protocol:'https', get:()=> 'sonuvi.test', ...extra };
}
function sharedFixture(fetchImpl=async()=>jsonResponse(rows)) {
  const controller=appFixture(), mobile=appFixture();
  let reads=0;
  registerConfigQueueWizardBasicRoutes(controller, {
    requireTrackKey(req,res) { if(req.headers['x-track-key']==='controller-test-key')return true;res.status(403).json({ok:false});return false; },
    readRadioCatalog:()=>{reads++;return readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl})},
  });
  const controllerCall=async(method,path,extra={})=>{
    const res=response();await controller.routes.get(method+' '+path)(request({headers:{'x-track-key':'controller-test-key'},...extra}),res);return res;
  };
  registerMobileRoutes(mobile, {
    enabled:true, apiSecret:'api-test-secret', trackIdSecret:'track-test-secret',
    fetchInternalRequest:async(path,options={})=>{
      const r=await controllerCall(options.method||'GET',path,{body:options.body||{}});
      return {ok:r.statusCode<400,status:r.statusCode,json:r.body};
    },
    serveHomeArtwork:async(res,descriptor)=>res.json({descriptor}),
  });
  const bearer=createMobileSessionToken({secret:'api-test-secret',deviceId:'radio-test-device'});
  const mobileCall=async(path,extra={})=>{
    const res=response();await mobile.routes.get('GET '+path)(request({headers:{authorization:'Bearer '+bearer},...extra}),res);return res;
  };
  return {controllerCall,mobileCall,readCount:()=>reads};
}

test('HTTP catalog uses only fixed read action without forwarded auth; preserves 242/16 and all identity fields',async()=>{
  let call;
  const result=await readMoodeRadioCatalog({baseUrl:'http://moode.test/ignored?cmd=write',fetchImpl:async(url,options)=>{call={url,options};return jsonResponse(rows)}});
  assert.equal(call.url,'http://moode.test/command/radio.php?cmd=get_stations');
  assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');
  assert.deepEqual(call.options.headers,{accept:'application/json'});assert(!('body' in call.options));
  assert.equal(result.length,242);assert.equal(result.filter(r=>r.type==='f').length,16);
  for(const raw of rows){const normalized=result.find(x=>x.id===String(raw.id));for(const key of ['station','name','genre','bitrate','format','type'])assert.equal(normalized[key],raw[key]);assert(!('home_page' in normalized))}
});

test('empty catalog is valid; malformed data and upstream authorization/server failures are explicit errors',async()=>{
  assert.deepEqual(await readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>jsonResponse([])}),[]);
  for(const value of [{stations:[]},null,[{}],[{...rows[0],station:''}],[{...rows[0],name:{bad:true}}]])
    await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>jsonResponse(value)}),unavailable);
  for(const status of [401,403,404,500,503])
    await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>new Response('private administrative error',{status})}),unavailable);
  await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>new Response('<html>private login</html>')}),unavailable);
  await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>{throw new Error('private network detail')}}),unavailable);
  await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://user:private@moode.test',fetchImpl:async()=>{assert.fail('credentials must not be sent')}}),unavailable);
});

test('HTTP timeout, redirect and response-size boundaries fail closed',async()=>{
  const server=http.createServer((req,res)=>{if(req.url.startsWith('/command/'))return;res.end()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(readMoodeRadioCatalog({baseUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:30}),unavailable)}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>new Response('[]',{headers:{'content-length':String(9*1024*1024)}})}),unavailable);
  await assert.rejects(readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>new Response(' '.repeat(8*1024*1024+1))}),unavailable);
  const redirect=http.createServer((req,res)=>{res.writeHead(302,{location:'/administrative-login'});res.end()});
  await new Promise(resolve=>redirect.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(readMoodeRadioCatalog({baseUrl:`http://127.0.0.1:${redirect.address().port}`}),unavailable)}
  finally{redirect.closeAllConnections();await new Promise(resolve=>redirect.close(resolve))}
});

test('catalog filters preserve favorite, genre, selected-URL and codec quality semantics',async()=>{
  const catalog=await readMoodeRadioCatalog({baseUrl:'http://moode.test',fetchImpl:async()=>jsonResponse(rows)});
  assert.equal(filterRadioCatalog(catalog,{favoritesOnly:true}).length,16);
  assert(filterRadioCatalog(catalog,{genres:['jAzZ']}).every(x=>x.genre==='Jazz'));
  assert.equal(filterRadioCatalog(catalog,{favoriteStations:[rows[0].station]})[0].id,'1');
  assert.equal(filterRadioCatalog(catalog,{genres:["Jazz'; delete from cfg_radio; --"]}).length,0);
  assert.equal(filterRadioCatalog(catalog,{maxStations:3}).length,3);
  const qualities=['FLAC','ALAC','WAV','AIFF','PCM','OPUS','MP3','AAC',''].map((format,i)=>({...catalog[0],id:String(i),format,bitrate:i<6?'128 kbps':'320'}));
  assert.equal(filterRadioCatalog(qualities,{hqOnly:true}).length,9);
  assert.equal(filterRadioCatalog([{...catalog[0],format:'AAC',bitrate:'128'}],{hqOnly:true}).length,0);
});

test('controller and bearer-authenticated mobile share 242/16 catalog, genres, stable IDs and opaque artwork',async()=>{
  const {controllerCall,mobileCall}=sharedFixture();
  const controller=await controllerCall('POST','/config/queue-wizard/radio-preview');
  const favorites=await controllerCall('GET','/config/queue-wizard/radio-favorites');
  const genres=await controllerCall('GET','/config/queue-wizard/radio-options');
  assert.equal(controller.body.count,242);assert.equal(favorites.body.count,16);
  assert.deepEqual(genres.body.genres,['Alternative','Classical','Jazz','Rock']);
  const mobile=await mobileCall('/v1/mobile/radio');
  const mobileFav=await mobileCall('/v1/mobile/radio',{query:{favoritesOnly:'true'}});
  const mobileGenres=await mobileCall('/v1/mobile/radio/options');
  assert.equal(mobile.body.items.length,242);assert.equal(mobileFav.body.items.length,16);assert.deepEqual(mobileGenres.body.genres,genres.body.genres);
  for(const track of controller.body.tracks){
    const id=createMobileTrackId({secret:'track-test-secret',trackIdentity:'mobile-rad-v1:'+track.file}).replace(/^trk_/,'rad_');
    const item=mobile.body.items.find(x=>x.id===id);assert(item);assert.equal(item.name,track.stationName);assert.equal(item.genre,track.genre);assert.equal(item.isFavorite,track.isFavoriteStation);
    assert(!('file' in item));assert(!JSON.stringify(item).includes(track.file));
    const artId=item.artworkUrl.split('/').at(-1);
    const art=await mobileCall('/v1/mobile/home/artwork/:artworkId',{params:{artworkId:artId}});
    assert.deepEqual(art.body.descriptor,{kind:'radio',reference:track.logoName});
  }
  const first=controller.body.tracks.find(t=>t.file===rows[0].station);
  assert.equal(first.logoName,rows[0].name);assert.equal(first.stationName,radioDisplayName(rows[0].name));
  assert.deepEqual(Object.keys(first).sort(),['artist','title','album','stationName','logoName','genre','bitrate','format','radioType','isFavoriteStation','file','isStream'].sort());
});

test('controller Track Key and mobile bearer boundaries reject missing/wrong credentials before catalog reads',async()=>{
  const f=sharedFixture();
  for(const [method,path] of [['POST','/config/queue-wizard/radio-preview'],['GET','/config/queue-wizard/radio-options'],['GET','/config/queue-wizard/radio-favorites']]){
    for(const headers of [{},{'x-track-key':'wrong'},{authorization:'Bearer invalid'}])assert.equal((await f.controllerCall(method,path,{headers})).statusCode,403);
  }
  for(const path of ['/v1/mobile/radio','/v1/mobile/radio/options'])
    for(const headers of [{},{authorization:'Bearer invalid'},{'x-track-key':'controller-test-key'}])assert.equal((await f.mobileCall(path,{headers})).statusCode,401);
  assert.equal(f.readCount(),0);
});

test('shared failures are 503 on both APIs, never zero stations; genuine empty catalogs remain 200',async()=>{
  for(const fetchImpl of [async()=>new Response('private upstream',{status:403}),async()=>{throw new Error('private network failure')},async()=>jsonResponse({bad:true})]){
    const f=sharedFixture(fetchImpl);
    for(const [method,path] of [['POST','/config/queue-wizard/radio-preview'],['GET','/config/queue-wizard/radio-favorites'],['GET','/config/queue-wizard/radio-options']]){
      const r=await f.controllerCall(method,path);assert.equal(r.statusCode,503);assert.equal(r.body.code,'RADIO_CATALOG_UNAVAILABLE');assert(!('tracks' in r.body));assert(!JSON.stringify(r.body).includes('private'));
    }
    for(const path of ['/v1/mobile/radio','/v1/mobile/radio/options']){
      const r=await f.mobileCall(path);assert.equal(r.statusCode,503);assert.equal(r.body.code,'RADIO_CATALOG_UNAVAILABLE');assert(!('items' in r.body));assert(!JSON.stringify(r.body).includes('private'));
    }
  }
  const f=sharedFixture(async()=>jsonResponse([]));
  assert.equal((await f.controllerCall('POST','/config/queue-wizard/radio-preview')).body.count,0);
  assert.deepEqual((await f.controllerCall('GET','/config/queue-wizard/radio-favorites')).body.favorites,[]);
  for(const path of ['/v1/mobile/radio','/v1/mobile/radio/options']){const r=await f.mobileCall(path);assert.equal(r.statusCode,200);assert.deepEqual(r.body.items||r.body.genres,[])}
});

test('favorite recents propagate retrieval failures and clear old rows after a legitimate empty catalog',async t=>{
  const app=appFixture();
  // Do not start unrelated MPD/index warmers in this route-only fixture.
  const timers=t.mock.method(globalThis,'setTimeout',()=>0);
  registerConfigBrowseRoutes(app,{requireTrackKey:()=>true});
  timers.mock.restore();
  let now=Date.now(), mode='failure';
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>{
    if(mode==='failure')return new Response('private upstream',{status:503});
    return jsonResponse({ok:true,favorites:mode==='empty'?[]:[{file:rows[0].station,stationName:'Test Station'}]});
  });
  const call=async()=>{const res=response();await app.routes.get('GET /recent/radio-favorites')(request(),res);return res};
  assert.equal((await call()).statusCode,503);
  mode='success';assert.equal((await call()).body.count,1);
  now+=6*60*1000;mode='empty';const empty=await call();assert.equal(empty.statusCode,200);assert.equal(empty.body.count,0);
  mode='failure';const failed=await call();assert.equal(failed.statusCode,503);assert(!('items' in failed.body));
});
