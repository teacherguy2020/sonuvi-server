import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMobileCatalog, publicMobileTrack, publicMobileAlbum } from '../src/lib/mobile-track-identity.mjs';
test('catalog years survive track and album projection without changing identity', () => {
 const tracks = [{file:'Artist/Album/01.flac',title:'Song',artist:'Artist',album:'Album',date:'2001-02-03'}];
 const catalog = buildMobileCatalog({tracks}, {trackIdSecret:'test-secret'});
 assert.equal(publicMobileTrack(catalog.tracks[0]).year, '2001-02-03');
 assert.equal(publicMobileAlbum(catalog.albums[0], catalog).year, '2001-02-03');
 const without = buildMobileCatalog({tracks:tracks.map(({date,...track}) => track)}, {trackIdSecret:'test-secret'});
 assert.equal(catalog.tracks[0].id, without.tracks[0].id);
 assert.equal(catalog.albums[0].id, without.albums[0].id);
 assert.equal(publicMobileAlbum(without.albums[0], without).year, null);
});
