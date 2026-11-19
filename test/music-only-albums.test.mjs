import assert from 'node:assert/strict';
import test from 'node:test';
import { isMusicLibraryTrack, musicLibraryCounts } from '../src/lib/music-library-counts.mjs';
import { buildMobileCatalog, publicMobileAlbum } from '../src/lib/mobile-track-identity.mjs';
import { buildMobileHomeRows } from '../src/lib/mobile-home-rows.mjs';
import { registerConfigBrowseRoutes } from '../src/routes/config.browse.routes.mjs';

const song = { id: 1, file: 'Music/Sting/All This Time/01.flac', artist: 'Sting', album: 'All This Time', title: 'Song', durationSec: 200 };
const podcast = { id: 99, file: 'USB/Podcasts/SmartLess/episode.mp3', artist: 'SmartLess', album: 'SmartLess', title: 'Episode' };
const video = { id: 98, file: 'USB/Videos/Sting/movie.mp4', artist: 'Sting', album: 'Sting Concert DVD', title: 'Concert' };
const flagged = { id: 97, file: 'Downloads/episode.mp3', artist: 'Host', album: 'A Show', title: 'Episode', isPodcast: true };
const mixed = { ...video, file: 'Music/Sting/All This Time/bonus.MOV', album: song.album };
const tracks = [podcast, video, flagged, mixed, song];
const albums = tracks.filter(t => t !== mixed).map(t => ({album:t.album, artist:t.artist, sampleFile:t.file, trackCount:1}));
const index = { builtAt: 'fixture', tracks, albums };
const register = () => {
  const handlers = new Map();
  registerConfigBrowseRoutes({get:(route,fn)=>handlers.set(route,fn),post:()=>{}}, {requireTrackKey:()=>true,warmCaches:false,getBrowseIndex:async()=>index});
  return async (route,query={},headers={}) => {
    let body;
    await handlers.get(route)({query,headers}, {json:value=>(body=value),status:code=>{throw new Error(`HTTP ${code}`);}});
    return body;
  };
};

test('music classification excludes video formats, dedicated folders and flags without title guessing', () => {
  for (const row of [podcast, video, flagged, mixed, {...song,isVideo:true}, {...song,file:'Video/Concert/audio.flac'}, {...song,file:'USB\\VIDEOS\\Concert\\audio.flac'}]) {
    assert.equal(isMusicLibraryTrack(row),false,row.file);
  }
  for (const file of ['Music/Video Games/song.flac','Music/Podcast Song/song.m4a','Music/Videography/song.mp3']) {
    assert.equal(isMusicLibraryTrack({...song,file}),true,file);
  }
  assert.deepEqual(musicLibraryCounts(tracks),{tracks:1,albums:1,artists:1});
});

test('native album/artist projections are music-only while all playback IDs and source data survive', () => {
  const original=structuredClone(index);
  const catalog=buildMobileCatalog(index,{trackIdSecret:'fixture'});
  const musicOnly=buildMobileCatalog({tracks:[song]},{trackIdSecret:'fixture'});
  assert.deepEqual(catalog.albums.map(a=>a.album),[song.album]);
  assert.deepEqual(catalog.artists.map(a=>a.artist),['Sting']);
  assert.equal(catalog.albums[0].trackCount,1);
  assert.equal(publicMobileAlbum(catalog.albums[0],catalog).durationSec,200);
  assert.equal(catalog.tracks.length,tracks.length);
  for (const row of tracks) assert.ok(catalog.byFile.get(row.file)?.id);
  assert.equal(catalog.byFile.get(song.file).id,musicOnly.byFile.get(song.file).id);
  assert.equal(catalog.albums[0].id,musicOnly.albums[0].id);
  assert.deepEqual(index,original);
});

test('browser recent albums filter before limits; browse, artist and album-detail agree', async () => {
  const read=register();
  const before=structuredClone(index);
  const recent=await read('/recent/albums',{limit:1},{'x-sonuvi-controller-dispatch':'fixture'});
  assert.deepEqual(recent.items.map(a=>a.album),[song.album]);
  assert.equal(recent.items[0].file,song.file);
  assert.deepEqual((await read('/config/browse/albums')).albums.map(a=>a.album),[song.album]);
  assert.deepEqual((await read('/config/browse/artist-albums',{artist:'Sting'})).albums.map(a=>a.album),[song.album]);
  assert.deepEqual((await read('/config/browse/album-tracks',{artist:'Sting',album:song.album})).tracks.map(t=>t.file),[song.file]);
  assert.deepEqual(index,before);
});

test('recent album library-health cache excludes podcasts and video before pagination', async () => {
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,albums:tracks.map(t=>({...t,sampleFile:t.file,folder:t.file.slice(0,t.file.lastIndexOf('/')),addedTs:t.id}))})});
  try {
    const result=await register()('/recent/albums',{limit:1});
    assert.deepEqual(result.items.map(a=>a.album),[song.album]);
    assert.equal(result.items[0].file,song.file);
  } finally { globalThis.fetch=previous; }
});

test('native album shelves reject stale nonmusic rows, while Podcast navigation payloads remain intact', () => {
  const catalog=buildMobileCatalog(index,{trackIdSecret:'fixture'});
  const sources=new Map([
    ['albums',{ok:true,payload:{items:tracks}}],
    ['local-topalbums',{ok:true,payload:{items:[{artist:podcast.artist,album:podcast.album},song]}}],
    ['podcasts',{ok:true,payload:{items:[{title:'SmartLess',rss:'https://example.test/feed.xml'}]}}],
  ]);
  const result=buildMobileHomeRows({catalog,sourcePayloads:sources,podcastIdFor:()=> 'podcast-fixture'});
  assert.deepEqual(result.rows.find(r=>r.id==='albums').items.map(i=>i.title),[song.album]);
  assert.deepEqual(result.rows.find(r=>r.id==='local-topalbums').items.map(i=>i.title),[song.album]);
  assert.equal(result.rows.find(r=>r.id==='podcasts').items[0].title,'SmartLess');
});
