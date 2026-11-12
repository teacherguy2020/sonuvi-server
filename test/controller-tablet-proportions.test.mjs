import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../controller-tablet.html', import.meta.url), 'utf8');
const renderedCardWidth = (containerWidth) => Math.min(390, Math.max(300, containerWidth * 0.31)) * 1.15 * 0.825;

test('tablet Now Playing card preserves the accepted native rendered widths', () => {
  assert.equal(Number(renderedCardWidth(1180).toFixed(5)), 347.05275);
  assert.equal(Number(renderedCardWidth(1024).toFixed(5)), 301.1712);
  assert.equal(Number(renderedCardWidth(1600).toFixed(5)), 370.0125);
});

test('tablet shell assigns the rendered card, search, and navigation the same column', () => {
  assert.match(page, /--tablet-np-source-width:clamp\(300px,31vw,390px\)/);
  assert.match(page, /--tablet-np-card-size:clamp\(284\.625px,29\.41125vw,370\.0125px\)/);
  assert.match(page, /grid-template-columns:var\(--tablet-np-card-size\) minmax\(0,1fr\)/);
  assert.match(page, /\.npTap\{width:var\(--tablet-np-card-size\);height:var\(--tablet-np-card-size\)/);
  assert.match(page, /\.quickWrap,:is\(body\.ipad11\.ipad11Landscape, body\.tablet\.tabletLandscape\) #libraryList\{width:var\(--tablet-np-card-size\)/);
  assert.match(page, /#libraryList\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('tablet portrait uses the reduced square with a scrolling page fallback', () => {
  assert.match(page, /--tablet-portrait-card-size:calc\(82\.5vw - 19\.8px\)/);
  assert.match(page, /overflow-y:auto/);
  assert.match(page, /@media \(max-width:540px\)/);
});

test('tablet portrait contains its metadata and transport controls inside the card grid', () => {
  const portrait = page.match(/\/\* Portrait keeps the same reduced native card[\s\S]*?(?=\n    @media \(max-width:540px\))/)?.[0] ?? '';

  assert.match(portrait, /\.npTap \.title\{display:none !important\}/);
  assert.match(portrait, /grid-template-rows:minmax\(0,1fr\) 2px minmax\(0,auto\)/);
  assert.match(portrait, /\.np > \.artWrap #art\{width:100% !important;height:auto !important;aspect-ratio:1\/1\}/);
  assert.doesNotMatch(portrait, /\.np img\{width:100% !important/);
  assert.match(portrait, /\.tabletNextUpInline \.nextUpArt\{width:22px !important;height:22px !important/);
  assert.match(portrait, /\.npCtrls\{grid-area:ctrls;position:static !important;left:auto !important;right:auto !important;top:auto !important;bottom:auto !important;transform:none !important/);
  assert.match(portrait, /backdrop-filter:none !important;-webkit-backdrop-filter:none !important;opacity:1 !important/);
});
