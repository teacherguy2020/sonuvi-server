// Synthetic fixture matching the observed moOde HTTP shape and 242/16 counts.
// No production station URLs, credentials or personal catalog are committed.
export function radioCatalogFixture() {
  return Array.from({ length: 242 }, (_, i) => ({
    id: i + 1,
    station: `http://radio-${i + 1}.example.test/live?quality=original`,
    name: i === 0 ? 'iHeart Test __NPSEP__ Café' : `Station ${String(i + 1).padStart(3, '0')}`,
    genre: ['Jazz', 'Rock / Alternative', 'Classical'][i % 3],
    bitrate: ['128 kbps', '320', '800'][i % 3],
    format: ['OPUS', 'MP3', 'FLAC'][i % 3],
    type: i < 16 ? 'f' : 'r',
    logo: 'local', home_page: 'https://example.test/',
  }));
}
