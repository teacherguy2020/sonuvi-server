import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_SETUP_CONTRACT, privateIPv4, resolvePlayer, validateMusicSetupRequest, catalogFiles, mappingCandidates, safeRelative, runMusicSetup } from '../src/lib/sonuvi-music-setup.mjs';
const target='sonuvi-target-v1-'+'a'.repeat(64);
const base={contract:MUSIC_SETUP_CONTRACT,targetIdentity:target,operation:'inspect',host:'moode.local',port:6600};
test('LAN discovery excludes loopback, public, mapped IPv6, malformed and link-local endpoints',async()=>{
 for(const ip of ['127.0.0.1','8.8.8.8','169.254.169.254','::ffff:10.0.0.4','010.0.0.1','10.0.0.256','172.32.0.1','192.169.0.1'])assert.equal(privateIPv4(ip),false,ip);
 for(const ip of ['10.0.0.254','172.16.0.1','172.31.0.4','192.168.1.1'])assert.equal(privateIPv4(ip),true);
 await assert.rejects(resolvePlayer('moode.local',async()=>[{address:'10.0.0.254'},{address:'8.8.8.8'}]),/music_player_not_private_lan/);
 assert.equal(await resolvePlayer('moode.local',async()=>[{address:'10.0.0.254'}]),'10.0.0.254');
});
test('fixed request rejects command/path injection, unbounded credentials and unsupported operations',()=>{
 assert.equal(validateMusicSetupRequest(base),base);
 for(const extra of [{host:'moode.local;id'},{port:0},{port:'6600'},{operation:'restart'},{command:'id'},{sharePassword:'x\nusername=root',shareUser:'a'},{sharePassword:'x'.repeat(257),shareUser:'a'}])assert.throws(()=>validateMusicSetupRequest({...base,...extra}));
 for(const share of ['../etc','Music,uid=0','//host/a','Music%u','Music\\a','/Music',''])assert.throws(()=>validateMusicSetupRequest({...base,operation:'apply',share}));
});
test('mapping is derived from the selected share and its contained music paths, never arbitrary filesystem input',()=>{
 const files=catalogFiles('file: USB/Disk/Artist/A.flac\nfile: USB/Disk/Podcasts/Show.mp3\nfile: https://example.com/radio\nfile: USB/Disk/Artist/B.flac\n');
 assert.equal(files.length,2);assert.deepEqual(mappingCandidates(files,'Disk'),['USB/Disk/','']);
 assert.deepEqual(mappingCandidates(['USB/Other/A.flac','USB/Disk/B.flac'],'Disk'),['USB/Disk/','']);
 for(const f of ['/etc/passwd','../a','a/../b','a/./b','a\\b','a\nb',''])assert.equal(safeRelative(f),false);
 assert.deepEqual(mappingCandidates(['USB/Disk/../../etc/passwd'],'Disk'),[]);
});
test('target identity is checked before any network or apply action',async()=>{
 let called=false;await assert.rejects(runMusicSetup({...base,targetIdentity:'sonuvi-target-v1-'+'b'.repeat(64)},{readIdentity:async()=>target,resolve:async()=>{called=true;}}),/music_target_mismatch/);assert.equal(called,false);
});
test('discovery and status cannot apply configuration; apply pins the resolved private address',async()=>{
 let applied=0;const deps={readIdentity:async()=>target,discoverPlayers:async()=>({players:[]}),readState:async()=>({state:'not-configured'}),resolve:async()=> '10.0.0.254',applySetup:async(r,ip)=>{applied++;assert.equal(ip,'10.0.0.254');return {state:'ready'};}};
 assert.deepEqual((await runMusicSetup({...base,operation:'discover'},deps)).players,[]);
 assert.equal((await runMusicSetup({...base,operation:'status'},deps)).state,'not-configured');assert.equal(applied,0);
 assert.equal((await runMusicSetup({...base,operation:'apply',share:'Disk'},deps)).state,'ready');assert.equal(applied,1);
});

test('selected-share indexing excludes inaccessible player-local files but preserves selected-share podcasts',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createBrowseIndexAdapter}=await import('../src/lib/browse-index.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-music-index-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const oldReady=process.env.SONUVI_MUSIC_CONFIGURED,oldPrefix=process.env.MOODE_USB_PREFIX;
 process.env.SONUVI_MUSIC_CONFIGURED='1';process.env.MOODE_USB_PREFIX='USB/Disk/';
 t.after(()=>{if(oldReady===undefined)delete process.env.SONUVI_MUSIC_CONFIGURED;else process.env.SONUVI_MUSIC_CONFIGURED=oldReady;if(oldPrefix===undefined)delete process.env.MOODE_USB_PREFIX;else process.env.MOODE_USB_PREFIX=oldPrefix;});
 let requestedPort=false;
 const adapter=createBrowseIndexAdapter({statePaths:{browseIndexPath:path.join(root,'index.json')},mpdPort:6601,
  runExecFile:async(file,args)=>{requestedPort ||= args.includes('6601');return {stdout:args.at(-1)==='listall'?'OSDISK/Demo.flac\tDemo\tDemo\tTest\tTest\t1\tTest\t12\nUSB/Disk/A.flac\tArtist\tArtist\tAlbum\tSong\t1\tRock\t60\nUSB/Disk/Podcasts/show.mp3\tHost\tHost\tShow\tEpisode\t1\tPodcast\t30\n':''};},
  readMpdRaw:async()=>''});
 const index=await adapter.getBrowseIndex('10.0.0.2',{force:true});
 assert.deepEqual(index.tracks.map(x=>x.file),['USB/Disk/A.flac','USB/Disk/Podcasts/show.mp3']);assert.equal(requestedPort,true);
});
