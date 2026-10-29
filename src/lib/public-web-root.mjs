import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// This is intentionally a positive allowlist. A newly added source file is not
// public merely because it sits beside an HTML page in an engineering checkout.
const PUBLIC_ROOT_HTML = new Set([
  'alexa.html', 'app.html', 'config.html', 'controller-albums.html', 'controller-artists.html',
  'controller-genres.html', 'controller-ipad.html', 'controller-iphone.html', 'controller-kiosk.html',
  'controller-mobile-settings.html', 'controller-mobile.html', 'controller-now-playing-grid.html',
  'controller-now-playing-ipad.html', 'controller-now-playing-iphone.html', 'controller-now-playing-tablet.html',
  'controller-now-playing.html', 'controller-nowplaying-iphone.html', 'controller-playlists.html',
  'controller-podcasts.html', 'controller-queue-wizard.html', 'controller-queue.html', 'controller-radio.html',
  'controller-tablet-settings.html', 'controller-tablet.html', 'controller-upnp.html', 'controller-visualizer.html',
  'controller.html', 'diagnostics.html', 'display.html', 'displays.html', 'index.html', 'index1080.html',
  'kiosk-albums.html', 'kiosk-artists.html', 'kiosk-designer.html', 'kiosk-genres.html', 'kiosk-now-playing.html',
  'kiosk-playlists.html', 'kiosk-podcasts.html', 'kiosk-queue-wizard.html', 'kiosk-queue.html', 'kiosk-radio.html',
  'kiosk.html', 'library-health.html', 'mobile.html', 'peppy.html', 'player-render.html', 'player.html',
  'podcasts.html', 'queue-wizard.html', 'radio-eval.html', 'radio.html', 'theme.html', 'visualizer.html', 'youtube.html',
]);

const PUBLIC_MANIFESTS = new Set([
  'manifest.webmanifest', 'manifest-controller.webmanifest', 'manifest-controller-ipad.webmanifest',
  'manifest-controller-iphone.webmanifest', 'manifest-controller-mobile.webmanifest',
  'manifest-controller-tablet.webmanifest',
]);

// This is generated only by the immutable release builder. It contains a
// release identity, never a config value, source path, or credential.
const PUBLIC_RELEASE_METADATA = new Set(['release.json']);

const PUBLIC_SCRIPTS = new Set([
  'about-card.js', 'alexa.js', 'client-preferences.js', 'diagnostics.js', 'echo-link-volume.js',
  'config-editable.js', 'hero-transport.js', 'index-ui.js', 'index.js', 'library-health.js', 'mobile-pairing-ui.js',
  'now-playing-art.js', 'podcasts.js', 'queue-wizard.js', 'radio.js', 'runtime-auth.js',
  'source-audio.js', 'theme-toggle.js', 'upnp-now-playing.js', 'web-stream.js',
]);

const PUBLIC_STYLES = new Set([
  'controller-modals.css', 'hero.css', 'index1080.css', 'podcasts.css', 'podcasts2.css',
]);

const PUBLIC_ASSET_EXTENSIONS = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.json', '.png', '.svg', '.ttf', '.txt', '.webp', '.woff', '.woff2',
]);

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function posixRelative(value) {
  return String(value || '').split(path.sep).join('/');
}

/** Normalize a request path without allowing encoded traversal or dotfiles. */
export function normalizePublicRequestPath(requestPath) {
  let value = String(requestPath || '').split(/[?#]/, 1)[0] || '/';
  if (value.includes('\\') || value.includes('\0')) return '';
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      return '';
    }
  }
  if (value.includes('\\') || value.includes('\0')) return '';
  const rawSegments = value.replace(/^\/+/, '').split('/').filter(Boolean);
  if (!rawSegments.length) return 'index.html';
  if (rawSegments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) return '';
  const normalized = path.posix.normalize(rawSegments.join('/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  return isPublicWebAsset(normalized) ? normalized : '';
}

export function isPublicWebAsset(relativePath) {
  const relative = posixRelative(relativePath).replace(/^\/+/, '');
  if (!relative || relative.includes('\0') || relative.split('/').some((segment) => !segment || segment.startsWith('.'))) return false;
  if (!relative.includes('/')) return PUBLIC_ROOT_HTML.has(relative) || PUBLIC_MANIFESTS.has(relative) || PUBLIC_RELEASE_METADATA.has(relative);

  const [directory, ...rest] = relative.split('/');
  const nested = rest.join('/');
  if (!nested || nested.split('/').some((segment) => segment.startsWith('.'))) return false;
  if (directory === 'scripts') return rest.length === 1 && PUBLIC_SCRIPTS.has(nested);
  if (directory === 'styles') return rest.length === 1 && PUBLIC_STYLES.has(nested);
  if (directory === 'icons') return ['.png', '.svg', '.ico'].includes(path.posix.extname(nested).toLowerCase());
  if (directory === 'assets') return PUBLIC_ASSET_EXTENSIONS.has(path.posix.extname(nested).toLowerCase());
  return false;
}

async function collectFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, childRelative));
    } else if (entry.isFile() && isPublicWebAsset(childRelative)) {
      files.push(childRelative);
    }
  }
  return files;
}

async function collectRootFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isPublicWebAsset(entry.name))
    .map((entry) => entry.name);
}

/**
 * Build a fresh, immutable public root. The target must not already exist;
 * H3 activation will select a new release directory instead of replacing an
 * active web root in place.
 */
export async function buildPublicWebRoot({ sourceRoot, outputRoot } = {}) {
  if (!String(sourceRoot || '').trim() || !String(outputRoot || '').trim()) {
    throw new Error('sourceRoot and outputRoot are required');
  }
  const source = path.resolve(String(sourceRoot));
  const output = path.resolve(String(outputRoot));
  if (source === output) throw new Error('sourceRoot and outputRoot must be distinct absolute paths');
  const sourceReal = await fs.realpath(source);
  const outputParent = path.dirname(output);
  try {
    await fs.lstat(output);
    throw new Error(`public web root already exists: ${output}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const files = await collectRootFiles(sourceReal);
  for (const relative of ['assets', 'icons', 'scripts', 'styles']) {
    try {
      files.push(...await collectFiles(sourceReal, relative));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const uniqueFiles = [...new Set(files)].sort();
  const stage = await fs.mkdtemp(path.join(outputParent, `.${path.basename(output)}.stage-`));
  try {
    for (const relative of uniqueFiles) {
      const sourcePath = path.join(sourceReal, relative);
      const sourceStat = await fs.lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
      const sourceFileReal = await fs.realpath(sourcePath);
      if (!contained(sourceReal, sourceFileReal)) continue;
      const targetPath = path.join(stage, relative);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourceFileReal, targetPath);
    }
    const manifest = {
      contract: 'sonuvi.public-web-root.v1',
      builtAt: new Date().toISOString(),
      files: uniqueFiles,
      fingerprint: crypto.createHash('sha256').update(uniqueFiles.join('\n')).digest('hex'),
    };
    await fs.rename(stage, output);
    return { outputRoot: output, files: uniqueFiles, manifest };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Resolve an individual request to a regular public asset, never a directory. */
export async function resolvePublicWebAsset({ publicRoot, requestPath } = {}) {
  const relative = normalizePublicRequestPath(requestPath);
  if (!relative) return null;
  const root = await fs.realpath(path.resolve(String(publicRoot || ''))).catch(() => '');
  if (!root) return null;
  const candidate = path.join(root, relative);
  if (!contained(root, candidate)) return null;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const real = await fs.realpath(candidate);
    return contained(root, real) ? real : null;
  } catch {
    return null;
  }
}
