import { MOODE_BASE_URL } from '../config.mjs';

const COLUMNS = ['station', 'name', 'genre', 'bitrate', 'format', 'type'];
const MAX_BYTES = 8 * 1024 * 1024;

export class RadioCatalogUnavailableError extends Error {
  constructor() {
    super('Radio catalog unavailable. Check the moOde connection and retry.');
    this.code = 'RADIO_CATALOG_UNAVAILABLE';
  }
}

// Only this existing read-only moOde action is used. Never forward controller
// credentials, cookies, SQL, filters or arbitrary commands to the receiver.
export async function readMoodeRadioCatalog({
  baseUrl = MOODE_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
} = {}) {
  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid origin');
    const url = new URL('/command/radio.php?cmd=get_stations', base);
    const response = await fetchImpl(url.toString(), {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Catalog request failed');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('Catalog too large');
      chunks.push(chunk);
    }
    const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid catalog');
    const stations = rows.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)
          || !/^\d+$/.test(String(row.id))
          || COLUMNS.some(key => !(key in row) || (row[key] !== null && typeof row[key] !== 'string') || String(row[key] ?? '').length > 16384)) {
        throw new Error('Invalid station');
      }
      const station = { id: String(row.id), ...Object.fromEntries(COLUMNS.map(key => [key, row[key] ?? ''])) };
      if (!station.station.trim() || !station.name.trim()) throw new Error('Missing station identity');
      return station;
    });
    // Preserve the former SQL order-by-name behavior and stream URL spelling.
    return stations.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch {
    // No upstream body, origin, cookie, command or credential enters API errors.
    throw new RadioCatalogUnavailableError();
  }
}

export function filterRadioCatalog(stations, { genres = [], favoritesOnly = false, hqOnly = false, favoriteStations = [], maxStations = 500 } = {}) {
  const terms = Array.isArray(genres) ? genres.map(x => String(x).trim().toLowerCase()).filter(Boolean) : [];
  const wanted = new Set(Array.isArray(favoriteStations) ? favoriteStations.map(x => String(x).trim()) : []);
  const limit = Number.isFinite(Number(maxStations)) ? Math.max(1, Math.min(2000, Math.floor(Number(maxStations)))) : 500;
  return stations.filter(row => {
    if (favoritesOnly && row.type.toLowerCase() !== 'f') return false;
    if (terms.length && !terms.some(term => row.genre.toLowerCase().includes(term))) return false;
    if (wanted.size && !wanted.has(row.station)) return false;
    if (hqOnly) {
      const format = row.format.toUpperCase(), bitrate = Number.parseInt(row.bitrate, 10) || 0;
      if (!(/FLAC|ALAC|WAV|AIFF|PCM/.test(format) || (/OPUS/.test(format) && bitrate >= 128) || ((/MP3|AAC/.test(format) || !format) && bitrate >= 320))) return false;
    }
    return true;
  }).slice(0, limit);
}
