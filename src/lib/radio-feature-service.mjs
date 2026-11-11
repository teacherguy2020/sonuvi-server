import { filterRadioCatalog } from './moode-radio-catalog.mjs';
import { radioDisplayName } from './radio-display.mjs';

// Queue wizard and mobile use this credential-free read-only service. Callers
// provide the existing catalog reader; no mobile request can become a
// Track-Key-bearing loopback request.
export function createRadioFeatureService({ readRadioCatalog } = {}) {
  if (typeof readRadioCatalog !== 'function') throw new Error('readRadioCatalog is required');
  const catalog = async () => readRadioCatalog();
  const options = async () => {
    const genres = new Map();
    for (const row of await catalog()) for (const raw of String(row?.genre || '').split(/[;,|/]/)) {
      const label = raw.trim();
      if (label && !genres.has(label.toLowerCase())) genres.set(label.toLowerCase(), label);
    }
    return { ok: true, genres: [...genres.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })) };
  };
  const favorites = async () => {
    const rows = (await catalog()).filter((row) => String(row?.type || '').toLowerCase() === 'f').map((row) => ({
      file: String(row.station || '').trim(), stationName: radioDisplayName(row.name),
      genre: String(row.genre || '').trim(), bitrate: String(row.bitrate || '').trim(),
      format: String(row.format || '').trim(), radioType: String(row.type || '').trim(),
    })).filter((row) => row.file);
    return { ok: true, count: rows.length, favorites: rows };
  };
  const preview = async (filters = {}) => {
    const tracks = filterRadioCatalog(await catalog(), filters).map((row) => {
      const logoName = String(row.name || '').trim();
      const stationName = radioDisplayName(logoName) || 'Radio Station';
      return { artist: stationName, title: '', album: stationName, stationName, logoName: logoName || stationName,
        genre: String(row.genre || '').trim(), bitrate: String(row.bitrate || '').trim(), format: String(row.format || '').trim(),
        radioType: String(row.type || '').trim(), isFavoriteStation: String(row.type || '').trim().toLowerCase() === 'f',
        file: String(row.station || '').trim(), isStream: true };
    }).filter((row) => row.file);
    return { ok: true, count: tracks.length, tracks };
  };
  return Object.freeze({ options, favorites, preview });
}
