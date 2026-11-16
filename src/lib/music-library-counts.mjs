// Music listings/counts are a read-only projection. Keep the full index and
// opaque IDs so Podcasts, Videos and existing queues retain playback access.
export function isMusicLibraryTrack(track) {
  const file = String(track?.file || '').trim().replaceAll('\\', '/');
  return Boolean(file) && !/^[a-z][a-z0-9+.-]*:/i.test(file)
    && track?.isMusic !== false
    && track?.isPodcast !== true
    && track?.isVideo !== true
    && !/(?:^|\/)(?:podcasts?|videos?)(?:\/|$)/i.test(file)
    && !/\.(?:mp4|m4v|mov|mkv|avi|webm|mpg|mpeg|wmv|m2ts|vob)$/i.test(file);
}

export function musicLibraryCounts(tracks) {
  if (!Array.isArray(tracks)) return null;
  const music = tracks.filter(isMusicLibraryTrack);
  const albums = new Set();
  const artists = new Set();
  const norm = value => String(value || '').trim().toLowerCase();
  for (const track of music) {
    const artist = norm(track.artist || track.albumArtist);
    const albumArtist = norm(track.albumArtist || track.artist);
    if (artist) artists.add(artist);
    const album = norm(track.album);
    if (album) albums.add(JSON.stringify([albumArtist, album]));
  }
  return { tracks: music.length, albums: albums.size, artists: artists.size };
}
