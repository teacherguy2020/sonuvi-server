import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appleCatalogArtistMatches,
  appleCatalogTitleMatches,
  createAppleCatalogSearchService,
} from '../src/services/apple-catalog-search.service.mjs';

function response(body, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => normalizedHeaders[String(name || '').toLowerCase()] || null,
    },
    json: async () => body,
  };
}

function catalogPayload({
  artist = 'Charlie Porter',
  title = 'A Deepening Sense',
  album = 'Immigration Nation',
  trackUrl = 'https://music.apple.com/us/album/immigration-nation/1802992259?i=1802992345',
  artworkUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/example/{w}x{h}bb.{f}',
} = {}) {
  return {
    results: {
      songs: {
        data: [{
          id: '1802992345',
          attributes: {
            artistName: artist,
            name: title,
            albumName: album,
            releaseDate: '2025-04-18',
            url: trackUrl,
            artwork: { url: artworkUrl },
          },
        }],
      },
    },
  };
}

test('Catalog Search returns a strictly matched Apple track with safe artwork', async () => {
  let calls = 0;
  const service = createAppleCatalogSearchService({
    developerToken: 'test-token',
    fetchImpl: async (url, init) => {
      calls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.music.apple.com');
      assert.equal(parsed.pathname, '/v1/catalog/us/search');
      assert.equal(parsed.searchParams.get('term'), 'Charlie Porter A Deepening Sense');
      assert.equal(parsed.searchParams.get('types'), 'songs');
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      assert.equal(init.redirect, 'error');
      return response(catalogPayload());
    },
  });

  const result = await service.lookup({
    artist: 'Charlie Porter',
    title: 'A Deepening Sense',
  });

  assert.deepEqual(result, {
    url: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/example/600x600bb.jpg',
    album: 'Immigration Nation',
    year: '2025',
    trackUrl: 'https://music.apple.com/us/album/immigration-nation/1802992259?i=1802992345',
    albumUrl: '',
    matchedArtist: 'Charlie Porter',
    matchedTitle: 'A Deepening Sense',
    reason: 'ok:catalog-search',
    matched: true,
  });

  const cached = await service.lookup({
    artist: '  Charlie Porter ',
    title: 'A Deepening Sense',
  });
  assert.equal(cached.reason, 'ok:catalog-search');
  assert.equal(calls, 1, 'the successful stream identity is cached');
});

test('Catalog Search rejects a same-title but wrong-artist result and caches the miss briefly', async () => {
  let calls = 0;
  const service = createAppleCatalogSearchService({
    developerToken: 'test-token',
    fetchImpl: async () => {
      calls += 1;
      return response(catalogPayload({ artist: 'Different Artist' }));
    },
  });

  const first = await service.lookup({
    artist: 'Charlie Porter',
    title: 'A Deepening Sense',
  });
  const second = await service.lookup({
    artist: 'Charlie Porter',
    title: 'A Deepening Sense',
  });

  assert.equal(first.matched, false);
  assert.equal(first.reason, 'catalog-no-strict-match');
  assert.equal(first.url, '');
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('Catalog Search rejects contradictory structural title numbers', () => {
  assert.equal(appleCatalogArtistMatches('The Example Trio feat. Guest', 'The Example Trio'), true);
  assert.equal(appleCatalogTitleMatches('Symphony No. 4: I. Allegro', 'Symphony No. 3: I. Allegro'), false);
  assert.equal(appleCatalogTitleMatches('Symphony No. 4: I. Allegro', 'Symphony No. 4: I. Allegro (Live)'), true);
});

test('Catalog Search single-flights concurrent lookups for the same stream identity', async () => {
  let calls = 0;
  let resolveFetch;
  const pendingResponse = new Promise((resolve) => { resolveFetch = resolve; });
  const service = createAppleCatalogSearchService({
    developerToken: 'test-token',
    fetchImpl: async () => {
      calls += 1;
      return pendingResponse;
    },
  });

  const first = service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' });
  const second = service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveFetch(response(catalogPayload()));

  assert.equal((await first).matched, true);
  assert.equal((await second).matched, true);
  assert.equal(calls, 1);
});

test('Catalog Search observes Retry-After and does not retry during its bounded backoff', async () => {
  let nowMs = 0;
  let calls = 0;
  const service = createAppleCatalogSearchService({
    developerToken: 'test-token',
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({}, { status: 429, headers: { 'retry-after': '7' } })
        : response(catalogPayload());
    },
  });

  assert.equal(
    (await service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' })).reason,
    'catalog-rate-limited',
  );
  nowMs = 6_000;
  assert.equal(
    (await service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' })).reason,
    'catalog-backoff-active:1s:429',
  );
  assert.equal(calls, 1);

  nowMs = 7_000;
  assert.equal(
    (await service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' })).reason,
    'ok:catalog-search',
  );
  assert.equal(calls, 2);
});

test('an unconfigured Catalog service never touches the network', async () => {
  let calls = 0;
  const service = createAppleCatalogSearchService({
    fetchImpl: async () => {
      calls += 1;
      return response(catalogPayload());
    },
  });

  const result = await service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' });
  assert.equal(result.reason, 'catalog-unconfigured');
  assert.equal(result.matched, false);
  assert.equal(calls, 0);
});

test('Catalog Search never returns a non-Apple track or artwork URL', async () => {
  const service = createAppleCatalogSearchService({
    developerToken: 'test-token',
    fetchImpl: async () => response(catalogPayload({
      trackUrl: 'https://untrusted.example/track',
      artworkUrl: 'https://untrusted.example/artwork.jpg',
    })),
  });

  const result = await service.lookup({ artist: 'Charlie Porter', title: 'A Deepening Sense' });
  assert.equal(result.matched, false);
  assert.equal(result.url, '');
  assert.equal(result.trackUrl, '');
  assert.equal(result.albumUrl, '');
});
