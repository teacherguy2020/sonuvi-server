export function normalizeGenreLabel(v = '') {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const keepUpper = new Set(['r&b', 'edm', 'dj', 'am', 'fm']);
  return lower
    .split(/\s+/)
    .map((w) => {
      if (keepUpper.has(w)) return w.toUpperCase();
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
