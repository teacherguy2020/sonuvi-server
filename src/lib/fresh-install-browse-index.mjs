import { createEmptyBrowseIndex } from './browse-index.mjs';

/**
 * Select the catalog provider for the process lifetime. A freshly installed
 * Server must be useful before any moOde/MPD destination is configured; it
 * therefore exposes a stable empty v2 index and never invokes the normal MPD
 * provider. Established installs delegate unchanged.
 */
export function createRuntimeBrowseIndexProvider({
  freshInstall = false,
  getMpdBrowseIndex,
  getMpdBrowseIndexStatus = async () => ({
    available: false,
    source: 'unavailable',
    builtAt: null,
    dbUpdateAt: null,
    counts: { artists: null, albums: null, tracks: null },
    refresh: { running: false },
  }),
} = {}) {
  if (typeof getMpdBrowseIndex !== 'function') throw new TypeError('MPD browse-index provider is required');
  if (!freshInstall) return Object.freeze({
    freshInstall: false,
    getBrowseIndex: (...args) => getMpdBrowseIndex(...args),
    getBrowseIndexStatus: (...args) => getMpdBrowseIndexStatus(...args),
  });
  const emptyIndex = createEmptyBrowseIndex();
  return Object.freeze({
    freshInstall: true,
    getBrowseIndex: async () => emptyIndex,
    getBrowseIndexStatus: async () => Object.freeze({
      available: true,
      source: 'fresh-install-empty',
      builtAt: emptyIndex.builtAt,
      dbUpdateAt: null,
      counts: { ...emptyIndex.counts },
      refresh: { running: false },
    }),
  });
}
