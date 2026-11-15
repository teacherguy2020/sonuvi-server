import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Real iframe, HTML, and authentication script: a parent auth global does not
// authenticate a frame. The mock server rejects mutations without frame CSRF.
test('Displays iframe initializes its own session and authenticates every push', {skip: !process.env.SONUVI_BROWSER_EXECUTABLE}, async () => {
  const browser = await chromium.launch({executablePath: process.env.SONUVI_BROWSER_EXECUTABLE, headless: true});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const modes = [];
    await page.route('http://sonuvi.test/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const json = value => route.fulfill({contentType:'application/json', body:JSON.stringify(value)});
      if(url.pathname === '/frame-test') return route.fulfill({contentType:'text/html',body:'<script>window.SonuviControllerAuth={ready:Promise.resolve(),csrfToken:"parent-only"}</script><iframe src="/displays.html"></iframe>'});
      if(url.pathname === '/__controller/config.js') return route.fulfill({contentType:'application/javascript',body:'globalThis.SonuviControllerWeb = true;'});
      if(url.pathname === '/__controller/session') return json({authenticated:true,role:'administrator',csrfToken:'frame-session-token'});
      if(url.pathname === '/__controller/configuration/display') {
        if(request.headers()['x-csrf-token'] !== 'frame-session-token') return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'CSRF validation failed.'})});
        const {mode}=request.postDataJSON(); modes.push(mode);
        return json({ok:true,verified:true,mode,url:`https://sonuvi.test/${mode}`});
      }
      const file=path.resolve(url.pathname.slice(1));
      if(file.startsWith(process.cwd() + path.sep)) {
        try { return await route.fulfill({body:await fs.readFile(file),contentType:file.endsWith('.js')?'application/javascript':'text/html'}); } catch {}
      }
      return json({});
    });
    await page.goto('http://sonuvi.test/frame-test');
    const frame=page.frameLocator('iframe');
    for(const label of ['Player','Peppy','Visualizer','Kiosk']) {
      await frame.locator(`#push${label}Btn`).click();
      await frame.locator(`#push${label}Status`).filter({hasText:'Pushed and verified:'}).waitFor();
    }
    assert.deepEqual(modes,['player','peppy','visualizer','kiosk']);
  } finally { await browser.close(); }
});
