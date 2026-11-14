import test from 'node:test';
import assert from 'node:assert/strict';
import { registerConfigBrowseRoutes } from '../src/routes/config.browse.routes.mjs';

test('album tracks use the same album-artist identity as Recently Added, including compilations', async () => {
  const handlers = new Map();
  const tracks = [
    {file:'Compilation/02.flac', album:'Shared Title', albumArtist:'Various Artists', artist:'Singer Two', title:'Second', track:'2'},
    {file:'Compilation/01.flac', album:'Shared Title', albumArtist:'Various Artists', artist:'Singer One', title:'First', track:'1'},
    {file:'Other/01.flac', album:'Shared Title', albumArtist:'Other Artist', artist:'Other Singer', title:'Not this album', track:'1'},
    {file:'Solo/01.flac', album:'Solo', artist:'Solo Artist', title:'Solo Song', track:'1'},
  ];
  registerConfigBrowseRoutes({get:(url,fn)=>handlers.set(url,fn),post:()=>{}}, {
    requireTrackKey:()=>true, warmCaches:false, getBrowseIndex:async()=>({tracks})
  });
  const read = async (album,artist) => {
    let result;
    await handlers.get('/config/browse/album-tracks')({query:{album,artist}}, {json:value=>(result=value)});
    return result;
  };
  assert.deepEqual((await read('Shared Title','Various Artists')).tracks.map(t=>t.title), ['First','Second']);
  assert.deepEqual((await read('Shared Title','Singer One')).tracks.map(t=>t.title), ['First']);
  assert.deepEqual((await read('Solo','Solo Artist')).tracks.map(t=>t.title), ['Solo Song']);
});
