import assert from 'node:assert/strict';
import test from 'node:test';
import { musicLibraryCounts, isMusicLibraryTrack } from '../src/lib/music-library-counts.mjs';
import { buildMobileCatalog } from '../src/lib/mobile-track-identity.mjs';

const music = {file:'USB/Music/Artist/Album/Podcast Song.flac', title:'Podcast Song', artist:'Artist', album:'Album'};
const episode = {file:'USB/SamsungMoode/Podcasts/Show/episode.mp3', title:'Episode', artist:'Host', album:'Show'};
test('music counts exclude podcast directory contents, not music titles', () => {
  assert.deepEqual(musicLibraryCounts([music, episode]), {tracks:1, albums:1, artists:1});
  assert.equal(isMusicLibraryTrack({...episode, file:'Podcasts/Show/episode.mp3'}), false);
  assert.equal(isMusicLibraryTrack({...episode, file:'/podcast/episode.mp3'}), false);
  assert.equal(isMusicLibraryTrack({...music, file:'USB/Music/Podcaster/Album/song.flac'}), true);
  assert.equal(isMusicLibraryTrack({...music, file:'https://example.test/radio'}), false);
  assert.deepEqual(musicLibraryCounts([]), {tracks:0, albums:0, artists:0});
  assert.equal(musicLibraryCounts(undefined), null);
});
test('mobile stats omit episodes without removing their playback identity', () => {
  const index = {builtAt:'fixture', tracks:[music, episode]};
  const before = structuredClone(index);
  const catalog = buildMobileCatalog(index, {trackIdSecret:'fixture-secret'});
  assert.deepEqual(catalog.counts, {tracks:1, albums:1, artists:1});
  assert.equal(catalog.tracks.length, 2);
  assert.ok(catalog.byFile.get(episode.file).id.startsWith('trk_'));
  assert.deepEqual(index, before);
  const alone = buildMobileCatalog({tracks:[music]}, {trackIdSecret:'fixture-secret'});
  assert.equal(catalog.byFile.get(music.file).id, alone.byFile.get(music.file).id);
});

test('explicit podcast metadata excludes nonstandard paths from music totals', () => {
  const episode = {file:'Audio/Downloads/episode.mp3', artist:'Host', album:'Show', title:'Episode', isPodcast:true};
  assert.equal(musicLibraryCounts([music, episode]).tracks, 1);
  assert.equal(buildMobileCatalog({tracks:[music, episode]}, {trackIdSecret:'fixture-secret'}).counts.tracks, 1);
});
