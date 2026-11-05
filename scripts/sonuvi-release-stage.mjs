#!/usr/bin/env node
import fs from 'node:fs/promises';

import { stageGateCReleaseArchive } from '../src/lib/sonuvi-gate-c-staging.mjs';

const TRUST_ANCHOR_PATH = '/etc/sonuvi/release-trust-anchors.json';
const HEADER_LIMIT = 64 * 1024;

async function framedInput(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error('release stage header is missing');
    buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) {
      if (buffered.length > HEADER_LIMIT) throw new Error('release stage header is too large');
      continue;
    }
    const header = JSON.parse(buffered.subarray(0, newline).toString('utf8'));
    const initial = buffered.subarray(newline + 1);
    return {
      header,
      archive: (async function* archive() {
        if (initial.length) yield initial;
        while (true) {
          const body = await iterator.next();
          if (body.done) return;
          yield Buffer.from(body.value);
        }
      }()),
    };
  }
}

if (process.getuid?.() !== 0) {
  process.stderr.write('sonuvi-release-stage requires explicit root authorization\n');
  process.exitCode = 77;
} else {
  try {
    const anchors = JSON.parse(await fs.readFile(TRUST_ANCHOR_PATH, 'utf8'));
    const { header, archive } = await framedInput(process.stdin);
    const result = await stageGateCReleaseArchive({ request: header, archive, trustedAnchors: anchors });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.message || 'release_stage_failed' })}\n`);
    process.exitCode = 1;
  }
}
