import { createEmptyBrowseIndex } from './browse-index.mjs';

/**
 * Select the catalog provider for the process lifetime. A freshly installed
 * Server must be useful before any moOde/MPD destination is configured; it
 * therefore exposes a stable empty v2 index and never invokes the normal MPD
 * provider. Established installs delegate unchanged.
 */
export function createRuntimeBrowseIndexProvider({ freshInstall = false, getMpdBrowseIndex } = {}) {
  if (typeof getMpdBrowseIndex !== 'function') throw new TypeError('MPD browse-index provider is required');
  if (!freshInstall) return Object.freeze({ freshInstall: false, getBrowseIndex: (...args) => getMpdBrowseIndex(...args) });
  const emptyIndex = createEmptyBrowseIndex();
  return Object.freeze({ freshInstall: true, getBrowseIndex: async () => emptyIndex });
}
