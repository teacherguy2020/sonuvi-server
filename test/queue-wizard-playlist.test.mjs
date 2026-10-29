import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fixture, ACK } from './fixtures/mpd-stored-playlist.mjs';
import { registerConfigQueueWizardApplyRoute } from '../src/routes/config.queue-wizard-apply.routes.mjs';
import { registerMobileRoutes } from '../src/routes/mobile.routes.mjs';
import { createMobileSessionToken } from '../src/lib/mobile-auth.mjs';

const app = () => {
  const routes=new Map();return {routes,get:(p,h)=>routes.set('GET '+p,h),post:(p,h)=>routes.set('POST '+p,h),delete:(p,h)=>routes.set('DELETE '+p,h)};
};
const response = () => ({statusCode:200,status(c){this.statusCode=c;return this},json(body){this.body=body;return this},set(){return this},setHeader(){},end(){}});
const request = body => ({headers:{'x-track-key':'test-key'},body,query:{},params:{},protocol:'https',get:()=> 'test.invalid'});
function routeFixture(mpd=fixture()) {
  const a=app();registerConfigQueueWizardApplyRoute(a,{
    mpdQueryRaw:mpd.query,
    requireTrackKey(req,res){if(req.headers['x-track-key']==='test-key')return true;res.status(403).json({ok:false});return false},
  });
  return {mpd,call:async(body,headers={'x-track-key':'test-key'},route='apply')=>{
    const res=response();await a.routes.get('POST /config/queue-wizard/'+route)({...request(body),headers},res);return res;
  }};
}

test('saveOnly response compatibility, auth, queue flags and cover warning; no SSH/CLI path is needed',async()=>{
  const f=routeFixture();
  const denied=await f.call({saveOnly:true,playlistName:'Mix',tracks:['x']},{});
  assert.equal(denied.statusCode,403);assert.equal(f.mpd.calls.length,0);
  const res=await f.call({saveOnly:true,playlistName:'Mix',tracks:['x','x'],play:true,shuffle:true,forceRandomOff:true,keepNowPlaying:true,generateCollage:true,previewCoverBase64:'YWJj'});
  assert.equal(res.statusCode,200);
  for(const key of ['ok','playlistSaved'])assert.equal(res.body[key],true);
  for(const key of ['didCrop','didClear','randomTurnedOff','shuffled','playStarted','collageGenerated'])assert.equal(res.body[key],false);
  assert.equal(res.body.added,0);assert.equal(res.body.requested,2);assert.equal(res.body.playlistError,'');
  assert.match(res.body.collageError,/existing cover was left unchanged/);
  assert.deepEqual(f.mpd.playlists.get('Mix'),['x','x']);assert.equal(f.mpd.queue.state,'pause');
});

test('saveOnly failure is a non-2xx error, never a false success; invalid requests perform no writes',async()=>{
  const f=routeFixture(fixture({Existing:['old']},({phase,verb})=>phase==='before'&&verb==='playlistadd'?ACK:undefined));
  const res=await f.call({saveOnly:true,playlistName:'Mix',tracks:['x']});
  assert.equal(res.statusCode,502);assert.equal(res.body.ok,false);assert.equal(res.body.playlistSaved,false);assert(res.body.error);
  assert.deepEqual(f.mpd.playlists.get('Existing'),['old']);
  for(const body of [{saveOnly:true,tracks:['x']},{saveOnly:true,playlistName:'Mix',tracks:[]},{saveOnly:true,playlistName:'../bad',tracks:['x']}]){
    const other=routeFixture();assert.equal((await other.call(body)).statusCode,400);assert.equal(other.mpd.calls.length,0);
  }
});

test('individual-track append, native bearer forwarding and ordinary queue apply retain existing behavior using a local mpc stub',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-playlist-test-'));
  const previousPath=process.env.PATH, previousState=process.env.SONUVI_TEST_PLAYLIST_FILE;
  const stateFile=path.join(dir,'state.json');
  const initial={playlists:{Mix:['old']},queue:['live-one','live-two'],state:'pause',calls:[]};
  await fs.writeFile(stateFile,JSON.stringify(initial));
  await fs.writeFile(path.join(dir,'mpc'),`#!${process.execPath}\nconst fs=require('node:fs');const file=process.env.SONUVI_TEST_PLAYLIST_FILE;const s=JSON.parse(fs.readFileSync(file));const args=process.argv.slice(2);if(args[0]!=='-h')process.exit(10);const [verb,name,track]=args.slice(2);s.calls.push([verb,name,track]);if(verb==='addplaylist'){if(track==='fail.flac')process.exit(1);s.playlists[name]=[...(s.playlists[name]||[]),track]}else if(verb==='add'){s.queue.push(name)}else{process.exit(11)}fs.writeFileSync(file,JSON.stringify(s));\n`,{mode:0o755});
  process.env.PATH=dir+path.delimiter+previousPath;process.env.SONUVI_TEST_PLAYLIST_FILE=stateFile;
  try {
    const f=routeFixture();
    const append=body=>f.call(body,{'x-track-key':'test-key'},'add-to-playlist');
    const one=await append({playlistName:'Mix',tracks:['USB/individual.flac']});
    assert.deepEqual(one.body,{ok:true,playlistName:'Mix',added:1});
    await append({playlistName:'New',tracks:['USB/new.flac']});
    await append({playlistName:'Mix',tracks:['USB/individual.flac']});
    const failed=await append({playlistName:'Mix',tracks:['fail.flac']});assert.equal(failed.statusCode,500);assert.equal(failed.body.ok,false);
    const mobile=app();const file='USB/Native/one.flac';let rejectSave=false;
    registerMobileRoutes(mobile,{
      enabled:true,apiSecret:'session-test',trackIdSecret:'id-test',
      getBrowseIndex:async()=>({tracks:[{file,artist:'Test',album:'Test',title:'One'}]}),
      fetchInternalRequest:async(route,options)=>{
        assert.equal(options.method,'POST');
        assert(['/config/queue-wizard/add-to-playlist','/config/queue-wizard/apply'].includes(route));
        if(route.endsWith('/apply')&&rejectSave)return {ok:false,status:502,json:{error:'Save unconfirmed',code:'PLAYLIST_RECOVERY_REQUIRED',recoveryPlaylists:['sonuvi-backup-fixture']}};
        const r=route.endsWith('/apply')?await f.call(options.body):await append(options.body);return {ok:r.statusCode<400,status:r.statusCode,json:r.body};
      },
    });
    const bearer=createMobileSessionToken({secret:'session-test',deviceId:'test-device'});
    const req={...request({}),headers:{authorization:'Bearer '+bearer}};
    const albumsRes=response();await mobile.routes.get('GET /v1/mobile/catalog/albums')(req,albumsRes);
    const tracksRes=response();await mobile.routes.get('GET /v1/mobile/catalog/albums/:albumId')({...req,params:{albumId:albumsRes.body.items[0].id}},tracksRes);
    assert.equal(tracksRes.body.tracks.length,1);
    const nativeRes=response();await mobile.routes.get('POST /v1/mobile/queue-wizard/add-to-playlist')({...req,body:{playlistName:'Mix',trackIds:[tracksRes.body.tracks[0].id]}},nativeRes);
    assert.deepEqual(nativeRes.body,{ok:true,playlistName:'Mix',added:1});
    const denied=response();await mobile.routes.get('POST /v1/mobile/queue-wizard/add-to-playlist')({...req,headers:{'x-track-key':'test-key'},body:{playlistName:'Mix',trackIds:[tracksRes.body.tracks[0].id]}},denied);assert.equal(denied.statusCode,401);
    let state=JSON.parse(await fs.readFile(stateFile,'utf8'));
    assert.deepEqual(state.queue,initial.queue);assert.equal(state.state,'pause');
    assert.deepEqual(state.playlists.Mix,['old','USB/individual.flac','USB/individual.flac',file]);
    assert.deepEqual(state.playlists.New,['USB/new.flac']);assert(state.calls.every(c=>c[0]==='addplaylist'));
    const saveBody={saveOnly:true,playlistName:'Mix',trackIds:[tracksRes.body.tracks[0].id],generateCollage:true};
    const saveRes=response();await mobile.routes.get('POST /v1/mobile/queue-wizard/apply')({...req,body:saveBody},saveRes);
    assert.equal(saveRes.statusCode,200);assert(saveRes.body.playlistSaved);assert.equal(saveRes.body.added,0);assert.equal(saveRes.body.playStarted,false);assert.match(saveRes.body.collageError,/existing cover/);assert.deepEqual(saveRes.body.playlistWarnings,[]);
    rejectSave=true;const saveError=response();await mobile.routes.get('POST /v1/mobile/queue-wizard/apply')({...req,body:saveBody},saveError);
    assert.equal(saveError.statusCode,502);assert.equal(saveError.body.ok,false);assert.equal(saveError.body.code,'PLAYLIST_RECOVERY_REQUIRED');assert.deepEqual(saveError.body.recoveryPlaylists,['sonuvi-backup-fixture']);

    // Ordinary append-to-queue still follows its pre-existing path, separately.
    const applied=await f.call({mode:'append',tracks:['queue-new.flac'],play:false});
    assert.equal(applied.body.added,1);assert.equal(applied.body.playStarted,false);assert.equal(applied.body.playlistSaved,false);
    state=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.deepEqual(state.queue,[...initial.queue,'queue-new.flac']);
  } finally {
    process.env.PATH=previousPath;if(previousState===undefined)delete process.env.SONUVI_TEST_PLAYLIST_FILE;else process.env.SONUVI_TEST_PLAYLIST_FILE=previousState;
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('Queue Wizard caller requires confirmed save and displays cover/cleanup warnings and save errors',async()=>{
  const html=await fs.readFile(new URL('../controller-queue-wizard.html',import.meta.url),'utf8');
  const start=html.indexOf('    async function saveToPlaylistOnly(){');const end=html.indexOf('    async function doApply(){',start);
  const fn=html.slice(start,end);
  for(const [reply,expected] of [
    [{ok:true,json:{ok:true,playlistSaved:true,playlistWarnings:['Recovery copy retained'],collageError:'Cover unchanged'}},/Saved playlist: Mix.*Recovery copy retained.*Cover unchanged/],
    [{ok:false,json:{ok:false,error:'Save unconfirmed'}},/Save failed: Save unconfirmed/],
    [{ok:true,json:{ok:true,playlistSaved:false,playlistError:'MPD rejected'}},/Save failed: MPD rejected/],
  ]) {
    const elements={savePlaylistName:{value:'Mix'},meta:{textContent:''}};
    const context=vm.createContext({$:id=>elements[id],previewTracks:[{file:'one.flac'}],collageDataBase64:'abc',collageMimeType:'image/jpeg',ensureKey:async()=>{},base:'http://fixture',headers:()=>({}),fetch:async()=>({ok:reply.ok,status:reply.ok?200:502,json:async()=>reply.json})});
    await vm.runInContext(fn+'\nsaveToPlaylistOnly()',context);assert.match(elements.meta.textContent,expected);
  }
});


test('save-only rejects existing names without any mutation even if a caller requests replacement',async()=>{
  const f=routeFixture(fixture({Mix:['old']}));
  const res=await f.call({saveOnly:true,playlistName:'Mix',tracks:['new'],replaceExisting:true});
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'PLAYLIST_EXISTS');assert.equal(res.body.playlistSaved,false);
  assert.deepEqual(f.mpd.playlists.get('Mix'),['old']);assert(f.mpd.calls.every(c=>['commands','listplaylists'].includes(c[0])));
});

test('a collage preview network failure cannot prevent the independent playlist save',async()=>{
  const html=await fs.readFile(new URL('../controller-queue-wizard.html',import.meta.url),'utf8');
  const start=html.indexOf('    async function saveToPlaylistOnly(){');const end=html.indexOf('    async function doApply(){',start);
  const elements={savePlaylistName:{value:'New'},meta:{textContent:''}};let saves=0;
  const context=vm.createContext({$:id=>elements[id],previewTracks:[{file:'one.flac'}],collageDataBase64:'',collageMimeType:'image/jpeg',refreshCollage:async()=>{throw Error('preview offline')},ensureKey:async()=>{},base:'http://fixture',headers:()=>({}),fetch:async()=>{saves++;return {ok:true,status:200,json:async()=>({ok:true,playlistSaved:true,collageError:'Cover not installed'})}}});
  await vm.runInContext(html.slice(start,end)+'\nsaveToPlaylistOnly()',context);
  assert.equal(saves,1);assert.match(elements.meta.textContent,/Saved playlist: New.*Cover not installed/);
});
