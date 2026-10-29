#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { runtimeStatePaths } from '../src/lib/runtime-state-paths.mjs';

const root = process.cwd();
const skinsDir = path.join(root, 'skins');
const configuredOutDir = String(process.env.SONUVI_PEPPY_EXPORT_ROOT || '').trim();
if (configuredOutDir && !path.isAbsolute(configuredOutDir)) {
  throw new Error('SONUVI_PEPPY_EXPORT_ROOT must be an absolute path when configured');
}
const outDir = configuredOutDir || runtimeStatePaths({ cwd: root }).peppyExportDir;
await fs.mkdir(outDir, { recursive: true });

const entries = await fs.readdir(skinsDir, { withFileTypes: true });
const blocks = [];

for (const ent of entries) {
  if (!ent.isDirectory()) continue;
  const skinDir = path.join(skinsDir, ent.name);
  const meterJson = path.join(skinDir, 'meter.json');
  try {
    const cfg = JSON.parse(await fs.readFile(meterJson, 'utf8'));
    if (String(cfg?.resolution || '') !== '1280x400') continue;
    const m = cfg.meter || {};
    const a = cfg.assets || {};

    // Native export currently supports circular schema only.
    if (String(m.type || 'circular') !== 'circular') {
      continue;
    }

    const block = [
      `[${cfg.name}]`,
      `meter.type = circular`,
      `channels = ${Number(m.channels || 2)}`,
      `ui.refresh.period = ${Number(m.uiRefreshPeriod || 0.033)}`,
      `bgr.filename = ${a.bgr || ''}`,
      ...(a.fgr ? [`fgr.filename = ${a.fgr}`] : []),
      `indicator.filename = ${a.indicator || ''}`,
      `steps.per.degree = ${Number(m.stepsPerDegree || 2)}`,
      `start.angle = ${Number(m.startAngle || 0)}`,
      `stop.angle = ${Number(m.stopAngle || 0)}`,
      `distance = ${Number(m.distance || 0)}`,
      `left.origin.x = ${Number(m.leftOrigin?.x || 0)}`,
      `left.origin.y = ${Number(m.leftOrigin?.y || 0)}`,
      `right.origin.x = ${Number(m.rightOrigin?.x || 0)}`,
      `right.origin.y = ${Number(m.rightOrigin?.y || 0)}`,
      `meter.x = ${Number(m.meterOffset?.x || 0)}`,
      `meter.y = ${Number(m.meterOffset?.y || 0)}`,
      `screen.bgr = ${m.screenBgr || ''}`,
      '',
    ].join('\n');
    blocks.push(block);

    for (const fname of [a.bgr, a.fgr, a.indicator].filter(Boolean)) {
      const src = path.join(skinDir, fname);
      const dst = path.join(outDir, fname);
      try { await fs.copyFile(src, dst); } catch {}
    }
  } catch {}
}

await fs.writeFile(path.join(outDir, 'meters.generated.txt'), blocks.join('\n'), 'utf8');
console.log(`Exported ${blocks.length} skin block(s) -> ${path.join('exports','peppymeter','1280x400')}`);
