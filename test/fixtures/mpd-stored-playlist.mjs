import assert from 'node:assert/strict';
import { saveStoredPlaylist } from '../../src/lib/mpd-stored-playlist.mjs';

export const ACK = 'ACK [50@0] {rename} rejected\n';
export function fixture(initial = {}, hook = () => undefined) {
  const playlists = new Map(Object.entries(initial).map(([name, files]) => [name, [...files]]));
  const queue = { state: 'pause', files: Array.from({ length: 111 }, (_, i) => `live-${i}.flac`), song: 37, elapsed: '42.5' };
  const originalQueue = structuredClone(queue);
  const calls = [];
  const verbs = ['commands', 'listplaylists', 'listplaylistinfo', 'playlistadd', 'rename', 'rm'];
  const query = async line => {
    assert(!line.includes('\n'), 'no MPD command injection');
    const words = line.match(/"(?:\\.|[^"\\])*"|[^ ]+/g).map(word => word.startsWith('"') ? word.slice(1,-1).replace(/\\(.)/g, '$1') : word);
    const [verb, a, b] = words;
    assert(verbs.includes(verb), `must never use live-queue or unrelated command: ${verb}`);
    calls.push(words);
    const before = await hook({ phase: 'before', verb, a, b, playlists, calls });
    if (before !== undefined) return before;
    let body = '';
    if (verb === 'commands') body = verbs.filter(v => v !== 'commands').map(v => `command: ${v}\n`).join('');
    if (verb === 'listplaylists') body = [...playlists.keys()].map(name => `playlist: ${name}\nLast-Modified: 2026-10-28T00:00:00Z\n`).join('');
    if (verb === 'listplaylistinfo') {
      if (!playlists.has(a)) return ACK;
      body = playlists.get(a).map(file => `file: ${file}\nTitle: fixture\n`).join('');
    }
    if (verb === 'playlistadd') playlists.set(a, [...(playlists.get(a) || []), b]);
    if (verb === 'rename') {
      if (!playlists.has(a) || playlists.has(b)) return ACK;
      playlists.set(b, playlists.get(a)); playlists.delete(a);
    }
    if (verb === 'rm') { if (!playlists.delete(a)) return ACK; }
    const after = await hook({ phase: 'after', verb, a, b, playlists, calls });
    if (after !== undefined) return after;
    assert.deepEqual(queue, originalQueue);
    return `${body}OK\n`;
  };
  return { playlists, queue, calls, query, save: (tracks = ['new.flac'], playlistName = 'Mix') => saveStoredPlaylist({query, tracks, playlistName, replaceExisting: true}) };
}
