import { randomUUID } from 'node:crypto';

const saving = new Set();
const REQUIRED = ['playlistadd', 'listplaylistinfo', 'listplaylists', 'rename', 'rm'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const values = (raw, key) => raw.split(/\r?\n/).filter(line => line.startsWith(`${key}: `)).map(line => line.slice(key.length + 2));
const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
function failure(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

// MPD rename does not overwrite, and command lists are not transactions. Build
// first, retain the previous playlist through promotion, and never use the queue.
export async function saveStoredPlaylist({ query, playlistName, tracks, replaceExisting = false }) {
  if (typeof playlistName !== 'string' || !playlistName.trim() || playlistName !== playlistName.trim()
    || /[\x00-\x1f\x7f/\\]/.test(playlistName) || ['.', '..'].includes(playlistName)
    || /^(sonuvi-tmp-|sonuvi-backup-)/.test(playlistName) || Buffer.byteLength(playlistName) > 200) {
    throw failure('PLAYLIST_INVALID', 'Invalid stored-playlist name.', 400);
  }
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 10000
    || tracks.some(track => typeof track !== 'string' || !track.trim() || /[\x00-\x1f\x7f]/.test(track) || Buffer.byteLength(track) > 8192)) {
    throw failure('PLAYLIST_INVALID', 'A nonempty list of valid track URIs is required (maximum 10000).', 400);
  }
  if (typeof query !== 'function') throw failure('PLAYLIST_UNAVAILABLE', 'MPD stored-playlist service is unavailable.', 503);
  if (saving.has(playlistName)) throw failure('PLAYLIST_BUSY', 'This playlist is already being saved. Try again shortly.', 409);
  saving.add(playlistName);
  const temporary = `sonuvi-tmp-${randomUUID()}`;
  const backup = `sonuvi-backup-${randomUUID()}`;
  let temporaryOwned = false;
  let oldMoved = false;
  let promotionAttempted = false;
  let uncertainRename = false;
  let original = null;
  const recovery = new Set();
  const command = async text => {
    let raw;
    try { raw = String(await query(text, 10000)); }
    catch { throw failure('PLAYLIST_TRANSPORT', 'MPD connection failed; the save could not be confirmed.'); }
    if (/(?:^|\n)ACK /.test(raw)) throw failure('PLAYLIST_MPD_REJECTED', 'MPD rejected a stored-playlist operation.');
    if (!/(?:^|\n)OK\r?\n$/.test(raw)) throw failure('PLAYLIST_TRANSPORT', 'MPD returned an incomplete response; the save could not be confirmed.');
    return raw;
  };
  const names = async () => values(await command('listplaylists'), 'playlist');
  const read = async name => values(await command(`listplaylistinfo ${quote(name)}`), 'file');
  const rename = async (from, to) => {
    try { await command(`rename ${quote(from)} ${quote(to)}`); }
    catch (error) {
      if (error.code === 'PLAYLIST_TRANSPORT') uncertainRename = true;
      throw error;
    }
  };
  const removeTemporary = async () => {
    if (!temporaryOwned) return;
    try {
      if ((await names()).includes(temporary)) await command(`rm ${quote(temporary)}`);
    } catch { recovery.add(temporary); }
  };
  try {
    const supported = values(await command('commands'), 'command');
    if (REQUIRED.some(name => !supported.includes(name))) {
      throw failure('PLAYLIST_UNSUPPORTED', 'MPD does not authorize the required stored-playlist commands.', 503);
    }
    const initialNames = await names();
    if (initialNames.includes(temporary) || initialNames.includes(backup)) throw failure('PLAYLIST_CONFLICT', 'Temporary playlist name collision.', 409);
    if (initialNames.includes(playlistName) && replaceExisting !== true) {
      throw failure('PLAYLIST_EXISTS', 'A playlist with this name already exists. Choose a new name; the existing playlist was not changed.', 409);
    }
    original = initialNames.includes(playlistName) ? await read(playlistName) : null;
    // From this point, cleanup is limited to the unique temporary name we own.
    temporaryOwned = true;
    for (const track of tracks) await command(`playlistadd ${quote(temporary)} ${quote(track)}`);
    if (!equal(await read(temporary), tracks)) throw failure('PLAYLIST_VERIFY_FAILED', 'MPD did not store the requested tracks in order.');
    const currentNames = await names();
    const current = currentNames.includes(playlistName) ? await read(playlistName) : null;
    if (!equal(current, original)) throw failure('PLAYLIST_CONFLICT', 'The destination playlist changed while saving. Please retry.', 409);
    if (original !== null) {
      await rename(playlistName, backup);
      oldMoved = true;
      // Catch an edit between the last check and rename; restore that latest copy.
      if (!equal(await read(backup), original)) throw failure('PLAYLIST_CONFLICT', 'The destination playlist changed while saving. Please retry.', 409);
    }
    promotionAttempted = true;
    await rename(temporary, playlistName);
    temporaryOwned = false;
    if (!equal(await read(playlistName), tracks)) {
      throw failure('PLAYLIST_VERIFY_FAILED', 'The promoted playlist could not be verified; recovery copies were retained.');
    }
    const warnings = [];
    if (oldMoved) {
      try {
        if (!equal(await read(backup), original)) throw new Error('backup changed');
        await command(`rm ${quote(backup)}`);
      } catch {
        recovery.add(backup);
        warnings.push('Playlist saved, but the previous-playlist recovery copy could not be removed.');
      }
    }
    return { playlistSaved: true, savedTracks: tracks.length, warnings, recoveryPlaylists: [...recovery] };
  } catch (error) {
    // A lost rename reply is ambiguous. Do not guess, delete a destination, or
    // overwrite another writer. Retain the exact operation names for recovery.
    if (uncertainRename) {
      recovery.add(playlistName);
      recovery.add(temporary);
      if (original !== null) recovery.add(backup);
    } else if (oldMoved) {
      try {
        const remaining = await names();
        if (remaining.includes(playlistName)) throw new Error('destination exists');
        await rename(backup, playlistName);
        oldMoved = false;
        await removeTemporary();
      } catch {
        recovery.add(backup);
        if (temporaryOwned) recovery.add(temporary);
      }
    } else if (!temporaryOwned && promotionAttempted) {
      recovery.add(playlistName);
    } else if (!promotionAttempted || error.code === 'PLAYLIST_MPD_REJECTED') {
      await removeTemporary();
    }
    if (recovery.size) {
      error.code = 'PLAYLIST_RECOVERY_REQUIRED';
      error.status = 502;
      error.message = 'Playlist save was not confirmed. Recovery playlists were retained; do not retry until their state is checked.';
    }
    error.recoveryPlaylists = [...recovery];
    throw error;
  } finally {
    saving.delete(playlistName);
  }
}
