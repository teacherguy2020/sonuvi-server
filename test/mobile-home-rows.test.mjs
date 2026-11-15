import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMobileCatalog } from '../src/lib/mobile-track-identity.mjs';
import {
  MOBILE_HOME_ROW_IDS,
  buildMobileLocalRecentHistory,
  buildMobileHomeRows,
  mobileHomeSourcePath,
  orderedMobileHomeRowIDs,
  sanitizeMobileHomeProfile,
} from '../src/lib/mobile-home-rows.mjs';

const secret = 'home-row-test-secret';

function catalog() {
  return buildMobileCatalog({
    builtAt: '2026-09-26T00:00:00.000Z',
    tracks: [{
      file: 'USB/Music/Artist/Album/01 - Track.mp3',
      artist: 'Artist',
      albumArtist: 'Artist',
      album: 'Album',
      title: 'Track',
      track: '1',
      genre: 'Rock',
      durationSec: 210,
    }],
  }, { trackIdSecret: secret });
}

test('mobile home profile preserves configured rows and safe defaults', () => {
  const profile = sanitizeMobileHomeProfile({
    recentRows: ['local-toptracks', 'local-toptracks', 'not-a-row', 'queue', 'radio', 'podcasts', 'albums'],
    recentCount: 99,
    theme: 'dark',
    showRecent: true,
  });

  assert.deepEqual(profile.recentRows, ['local-toptracks', 'queue', 'radio', 'podcasts']);
  assert.equal(profile.recentCount, 30);
  assert.equal(profile.theme, 'dark');
  assert.equal(mobileHomeSourcePath('local-toptracks', 18), '/config/listening-history/top-tracks?limit=18');
});

test('mobile Home puts configured shelves first and preserves every remaining source', () => {
  const profile = {
    recentRows: ['local-toptracks', 'queue', 'radio', 'podcasts'],
  };
  const expected = [
    ...profile.recentRows,
    ...MOBILE_HOME_ROW_IDS.filter((row) => !profile.recentRows.includes(row)),
  ];

  assert.deepEqual(orderedMobileHomeRowIDs(profile), expected);

  const result = buildMobileHomeRows({
    profile,
    catalog: catalog(),
    sourcePayloads: new Map(),
  });

  assert.deepEqual(result.rows.map((row) => row.id), expected);
  assert.equal(result.rows[4].available, false);
});

test('mobile home queue row exposes upcoming queue tracks without raw MPD paths', () => {
  const built = catalog();
  const result = buildMobileHomeRows({
    profile: { recentRows: ['queue'] },
    catalog: built,
    baseUrl: 'http://nowplaying.local:3101',
    makeItemId: ({ source, kind, identity }) => `itm_${source}_${kind}_${identity}`,
    artworkUrlFor: ({ kind, reference }) => `http://nowplaying.local:3101/v1/mobile/home/artwork/${kind}-${encodeURIComponent(reference)}`,
    sourcePayloads: new Map([
      ['queue', {
        ok: true,
        payload: {
          headPos: 1,
          items: [
            {
              id: 'queue_current',
              position: 1,
              isCurrent: true,
              title: 'Current',
              artist: 'Artist',
              album: 'Album',
              file: 'USB/Music/Artist/Album/01 - Track.mp3',
            },
            {
              id: 'queue_next',
              position: 2,
              isCurrent: false,
              title: 'Track',
              artist: 'Artist',
              album: 'Album',
              file: 'USB/Music/Artist/Album/01 - Track.mp3',
            },
          ],
        },
      }],
    ]),
  });

  assert.equal(result.rows[0].id, 'queue');
  assert.equal(result.rows[0].title, 'Live Queue');
  assert.equal(result.rows[0].items.length, 1);
  assert.equal(result.rows[0].items[0].id, 'itm_queue_track_queue_next');
  assert.equal(result.rows[0].items[0].queueItemId, 'queue_next');
  assert.equal(result.rows[0].items[0].track.title, 'Track');
  assert.doesNotMatch(JSON.stringify(result), /USB\/Music/);
});

test('mobile home rows normalize local track and playlist art through mobile DTOs', () => {
  const built = catalog();
  const playlist = {
    id: 'pl_test',
    name: 'Favorites',
    trackCount: 1,
    revision: 'rev_test',
    updatedAt: null,
    artworkUrl: 'http://nowplaying.local:3101/v1/mobile/artwork/track-art',
  };
  const result = buildMobileHomeRows({
    profile: { recentRows: ['local-toptracks', 'playlists', 'radio', 'podcasts'] },
    catalog: built,
    playlistSummaries: [playlist],
    baseUrl: 'http://nowplaying.local:3101',
    makeItemId: ({ source, kind, identity }) => `itm_${source}_${kind}_${identity}`,
    artworkUrlFor: ({ kind, reference }) => `http://nowplaying.local:3101/v1/mobile/home/artwork/${kind}-${encodeURIComponent(reference)}`,
    podcastIdFor: (rss) => `pod_${rss}`,
    radioStationIdFor: (file) => `rad_${file}`,
    sourcePayloads: new Map([
      ['local-toptracks', {
        ok: true,
        payload: { items: [{ title: 'Track', artist: 'Artist', album: 'Album', file: 'USB/Music/Artist/Album/01 - Track.mp3' }] },
      }],
      ['playlists', { ok: true, payload: { items: [{ title: 'Favorites', playlist: 'Favorites' }] } }],
      ['radio', { ok: true, payload: { items: [{ stationName: 'Jazz FM', file: 'https://radio.example/jazz' }] } }],
      ['podcasts', { ok: true, payload: { items: [{ title: 'A Show', rss: 'https://example.com/feed.xml', imageUrl: 'https://example.com/cover.jpg' }] } }],
    ]),
  });

  assert.equal(result.rows.length, MOBILE_HOME_ROW_IDS.length);
  assert.deepEqual(result.rows.slice(0, 4).map((row) => row.id), [
    'local-toptracks',
    'playlists',
    'radio',
    'podcasts',
  ]);
  assert.equal(result.rows[0].items[0].track.title, 'Track');
  assert.equal(result.rows[0].items[0].albumItem.album, 'Album');
  assert.match(result.rows[0].items[0].artworkUrl, /\/v1\/mobile\/artwork\//);
  assert.equal(result.rows[1].items[0].playlist.name, 'Favorites');
  assert.match(result.rows[2].items[0].artworkUrl, /home\/artwork\/radio-/);
  assert.equal(result.rows[2].items[0].radioStationId, 'rad_https://radio.example/jazz');
  assert.equal(result.rows[3].items[0].podcastId, 'pod_https://example.com/feed.xml');
  assert.match(result.rows[3].items[0].artworkUrl, /home\/artwork\/remote-/);
  assert.doesNotMatch(JSON.stringify(result), /USB\/Music/);
});

test('mobile home rows resolve album and artist destinations without source file matches', () => {
  const built = catalog();
  const result = buildMobileHomeRows({
    profile: { recentRows: ['albums', 'local-topartists', 'lastfm-toptracks', 'radio'] },
    catalog: built,
    baseUrl: 'http://nowplaying.local:3101',
    makeItemId: ({ source, kind, identity }) => `itm_${source}_${kind}_${identity}`,
    artworkUrlFor: ({ kind, reference }) => `http://nowplaying.local:3101/v1/mobile/home/artwork/${kind}-${encodeURIComponent(reference)}`,
    sourcePayloads: new Map([
      ['albums', { ok: true, payload: { items: [{ title: 'Album', album: 'Album', artist: 'Artist' }] } }],
      ['local-topartists', { ok: true, payload: { items: [{ title: 'Artist', artist: 'Artist' }] } }],
      ['lastfm-toptracks', { ok: true, payload: { items: [{ title: 'Track', track: 'Track', artist: 'Artist', album: 'Album' }] } }],
      ['radio', { ok: true, payload: { items: [] } }],
    ]),
  });

  assert.equal(result.rows[0].items[0].albumItem.album, 'Album');
  assert.equal(result.rows[1].items[0].artistItem.artist, 'Artist');
  assert.equal(result.rows[2].items[0].albumItem.album, 'Album');
  assert.equal(result.rows[2].items[0].track.title, 'Track');
});

test('local recent history is available independently from selected visible shelves', () => {
  const built = catalog();
  const localRecentHistory = buildMobileLocalRecentHistory({
    catalog: built,
    baseUrl: 'http://nowplaying.local:3101',
    makeItemId: ({ source, kind, identity }) => `itm_${source}_${kind}_${identity}`,
    sourcePayload: {
      ok: true,
      payload: {
        items: [{
          title: 'Track', artist: 'Artist', album: 'Album',
          file: 'USB/Music/Artist/Album/01 - Track.mp3',
        }],
      },
    },
  });

  assert.equal(localRecentHistory.id, 'local-recenttracks');
  assert.equal(localRecentHistory.available, true);
  assert.equal(localRecentHistory.items[0].track.genre, 'Rock');
  assert.doesNotMatch(JSON.stringify(localRecentHistory), /USB\/Music/);
});
