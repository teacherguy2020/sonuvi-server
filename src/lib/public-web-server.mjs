import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePublicWebAsset } from './public-web-root.mjs';

const MIME_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const PUBLIC_WEB_LISTEN_HOSTS = new Set(['127.0.0.1', '0.0.0.0']);

/** Keep the public web listener explicit; immutable releases never accept arbitrary bind addresses. */
export function resolvePublicWebListenHost(value) {
  const host = String(value || '').trim() || '127.0.0.1';
  if (!PUBLIC_WEB_LISTEN_HOSTS.has(host)) {
    throw new Error('SONUVI_WEB_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sendStatus(response, statusCode) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(statusCode === 404 ? 'Not found\n' : 'Method not allowed\n');
}

/**
 * Serve only assets accepted by the H2 positive allowlist. This deliberately
 * has no directory listing or catch-all checkout fallback.
 */
export async function createPublicWebServer({ publicRoot } = {}) {
  if (!String(publicRoot || '').trim() || !path.isAbsolute(publicRoot)) {
    throw new Error('public web root must be an absolute path');
  }
  const root = await fs.realpath(publicRoot).catch(() => '');
  if (!root) throw new Error('public web root does not exist');
  const stat = await fs.lstat(root);
  if (!stat.isDirectory()) throw new Error('public web root is not a directory');

  return http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())) {
      sendStatus(response, 405);
      return;
    }
    const asset = await resolvePublicWebAsset({ publicRoot: root, requestPath: request.url || '/' });
    if (!asset) {
      sendStatus(response, 404);
      return;
    }
    try {
      const stat = await fs.stat(asset);
      response.statusCode = 200;
      response.setHeader('content-type', mimeType(asset));
      response.setHeader('content-length', String(stat.size));
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('cache-control', asset.endsWith('/release.json') || asset.endsWith('release.json')
        ? 'no-cache'
        : 'public, max-age=300');
      if (String(request.method || 'GET').toUpperCase() === 'HEAD') {
        response.end();
        return;
      }
      response.end(await fs.readFile(asset));
    } catch {
      sendStatus(response, 404);
    }
  });
}
