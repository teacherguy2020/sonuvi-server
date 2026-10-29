import net from 'node:net';
import { MPD_HOST, MPD_PORT } from '../config.mjs';
import { runtimeCapabilities } from '../lib/runtime-capabilities.mjs';

const READ_ONLY_MPD_COMMANDS = new Set([
  'commands', 'notcommands', 'tagtypes', 'urlhandlers', 'decoders', 'status',
  'currentsong', 'stats', 'playlistinfo', 'playlistid', 'listplaylists',
  'listall', 'listallinfo', 'find', 'search', 'count', 'outputs', 'channels',
  'readmessages', 'albumart', 'readpicture',
]);

function mpdCommandCapability(command) {
  const normalized = String(command || '').trim().toLowerCase();
  const verb = normalized.split(/\s+/, 1)[0];
  if (READ_ONLY_MPD_COMMANDS.has(verb) || normalized.startsWith('sticker get ')) {
    return { capability: 'mpd.read', readOnly: true };
  }
  return { capability: 'mpd.write', readOnly: false };
}

export function mpdEscapeValue(v) {
  const s = String(v || '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function mpdHasACK(raw) {
  return /(?:^|\r?\n)ACK\b/.test(String(raw || ''));
}

export function parseMpdFirstBlock(txt) {
  const out = {};
  const lines = String(txt || '').split('\n');

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('OK MPD ')) continue;
    if (line === 'OK') break;
    if (line.startsWith('ACK')) break;

    const i = line.indexOf(':');
    if (i <= 0) continue;

    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

export function parseMpdKeyVals(txt) {
  const out = {};
  const lines = String(txt || '').split('\n');

  for (const line0 of lines) {
    const line = String(line0 || '').trim();
    if (!line) continue;
    if (line.startsWith('OK MPD ')) continue;
    if (line === 'OK') break;
    if (line.startsWith('ACK')) break;

    const i = line.indexOf(':');
    if (i <= 0) continue;

    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

export async function mpdGetStatus() {
  const raw = await mpdQueryRaw('status');
  if (!raw || mpdHasACK(raw)) throw new Error('mpd status failed');

  const kv = parseMpdKeyVals(raw);

  const state = String(kv.state || '').trim();
  const song = (kv.song !== undefined) ? Number.parseInt(String(kv.song).trim(), 10) : null;
  const playlistlength =
    (kv.playlistlength !== undefined)
      ? Number.parseInt(String(kv.playlistlength).trim(), 10)
      : 0;

  return {
    state: state || '',
    song: Number.isFinite(song) ? song : null,
    playlistlength: Number.isFinite(playlistlength) ? playlistlength : 0,
  };
}

export async function mpdPlay(pos) {
  if (pos === 0 || Number.isFinite(Number(pos))) {
    await mpdQueryRaw(`play ${Number(pos)}`);
    return true;
  }
  await mpdQueryRaw('play');
  return true;
}

export async function mpdPlayId(songId) {
  const id = Number(songId);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('invalid MPD song id');
  }

  const raw = await mpdQueryRaw(`playid ${id}`);
  if (mpdHasACK(raw)) {
    throw new Error(`MPD rejected playid ${id}`);
  }
  return true;
}

export async function mpdPause(on) {
  const v = on ? 1 : 0;
  await mpdQueryRaw(`pause ${v}`);
  return true;
}

export async function mpdStop() {
  await mpdQueryRaw('stop');
  return true;
}

export function mpdQueryRaw(command, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    try {
      const capability = mpdCommandCapability(command);
      const runtime = runtimeCapabilities();
      if (capability.readOnly) runtime.assertExternalRead(capability.capability);
      else runtime.assertExternalMutation(capability.capability);
    } catch (error) {
      reject(error);
      return;
    }
    const sock = net.createConnection({ host: MPD_HOST, port: MPD_PORT });

    let buf = '';
    let finished = false;
    let greetingSeen = false;
    let commandSent = false;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve(buf);
    };

    sock.setTimeout(timeoutMs, () => finish(new Error('mpd timeout')));
    sock.on('error', finish);

    const hasTerminalOK = (s) => /(?:\r?\n)OK\r?\n/.test(s) || /^OK\r?\n/.test(s);
    const hasACK = (s) => /(?:\r?\n)ACK /.test(s) || /^ACK /.test(s);

    sock.on('data', (d) => {
      buf += d.toString('utf8');

      if (!greetingSeen) {
        if (buf.includes('OK MPD ') && buf.includes('\n')) greetingSeen = true;
        else return;
      }

      if (!commandSent) {
        commandSent = true;
        // Let MPD finish sending the command response before disconnecting.
        // Pipelining `close` here can truncate large find/search responses
        // (MPD was returning exactly one 16 KiB chunk for large artist
        // queries, which made otherwise valid artists appear incomplete).
        sock.write(`${command}\n`);
        return;
      }

      if (hasACK(buf) || hasTerminalOK(buf)) finish();
    });

    sock.on('end', () => finish());
  });
}
