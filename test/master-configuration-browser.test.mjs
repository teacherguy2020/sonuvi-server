import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { initializeMasterConfiguration, createMasterConfigurationStore } from '../src/lib/master-configuration.mjs';
import {registerMasterConfigurationRoutes} from '../src/routes/master-configuration.routes.mjs';

test('actual configuration page synchronizes forms and JSON through real validation and atomic persistence', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-browser-master-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'config.json'),document=initializeMasterConfiguration();document.plugins.radio.enabled=false;delete document.plugins.millsDisplay;
  await fs.writeFile(file,JSON.stringify(document));
  const store=createMasterConfigurationStore(file),routes=new Map();
  registerMasterConfigurationRoutes(Object.fromEntries(['get','put','post'].map(method=>[method,(path,handler)=>routes.set(method.toUpperCase()+' '+path,handler)])),{store,authorize:async()=>true});
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    let saves = 0;
    document.plugins.alexa.enabled=true;document.plugins.alexa.publicDomain="music.example.com";await fs.writeFile(file,JSON.stringify(document));
    await page.route('http://configuration.test/**', async route => {
      const url = new URL(route.request().url());
      if(url.pathname.startsWith('/__controller/configuration')) {
        const method=route.request().method(),target=url.pathname.replace('/__controller/configuration','/v1/admin/configuration/master');
        const handler=routes.get(method+' '+target);assert.ok(handler);
        const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
        await handler({body:method==='GET'?undefined:route.request().postDataJSON()},response);
        if(method==='PUT'&&response.body.ok)saves++;
        return route.fulfill({status:response.statusCode,json:response.body});
      }
      if(url.pathname==='/__controller/config.js' || url.pathname==='/scripts/controller-browser-auth.js') return route.fulfill({contentType:'text/javascript',body:''});
      const file=url.pathname==='/config.html'?'config.html':url.pathname.slice(1);
      if(!['config.html','scripts/config-theme.js','scripts/master-configuration-editor.mjs','scripts/master-configuration-draft.mjs'].includes(file)) return route.abort();
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':'text/javascript',body:await fs.readFile(new URL('../'+file,import.meta.url),'utf8')});
    });
    await page.goto('http://configuration.test/config.html');
    await page.locator('[data-plugin=radio]').waitFor();
    assert.equal(await page.locator('.card-body:visible').count(),0);
    assert.equal(await page.locator('[data-plugin=mills]').count(),0);
    await page.getByRole('searchbox').fill('Last.fm');
    assert.equal(await page.locator('.plugin-card:visible').count(),1);
    await page.getByRole('searchbox').fill('no matches');
    assert.equal(await page.getByText('No integrations match your search.').isVisible(),true);
    await page.getByRole('searchbox').fill('');
    await page.getByRole('button',{name:'Devices',exact:true}).click();
    assert.equal(await page.locator('[data-plugin=radio]').isVisible(),false);
    await page.getByRole('button',{name:'All integrations',exact:true}).click();
    const radio=page.locator('[data-plugin=radio]');
    await radio.getByRole('button',{name:'Configure Radio',exact:true}).click();
    await radio.locator('summary',{hasText:'Plugin Config'}).click();
    await radio.locator('input[type=checkbox]').check();
    const alexa=page.locator('[data-plugin=alexa]');
    await alexa.getByRole('button',{name:'Configure Alexa',exact:true}).click();
    assert.match(await alexa.innerText(),/Saved settings do not mean Alexa is ready/);
    await alexa.getByRole('button',{name:'Check Alexa connection'}).click();
    assert.match(await alexa.innerText(),/Save your settings before checking/);
    await page.getByText('Advanced · Master JSON',{exact:true}).click();
    const master=page.getByRole('textbox',{name:'Complete master configuration JSON'});
    assert.equal(JSON.parse(await master.inputValue()).plugins.radio.enabled,true);
    await radio.locator('summary',{hasText:'JSON Config'}).click();
    const plugin=radio.locator('details').filter({has:page.locator('summary',{hasText:'JSON Config'})}).locator('textarea');
    assert.equal(JSON.parse(await plugin.inputValue()).enabled,true);
    await plugin.fill('{broken');
    await page.getByRole('button',{name:'Save / Update'}).click();
    assert.equal(saves,0);
    assert.equal(await plugin.inputValue(),'{broken');
    await plugin.fill('{"enabled":false,"runtimeOptions":{}}');
    await plugin.blur();
    assert.equal(JSON.parse(await master.inputValue()).plugins.radio.enabled,false);
    const edited=JSON.parse(await master.inputValue()); edited.plugins.radio.enabled=true;
    await master.fill(JSON.stringify(edited));
    assert.equal(await radio.locator('input[type=checkbox]').isChecked(),true);
    await page.getByRole('button',{name:'Save / Update'}).click();
    await page.getByRole('status').filter({hasText:'Saved revision'}).waitFor();
    assert.equal(saves,1);assert.equal((await store.read()).document.plugins.radio.enabled,true);
    if(await page.locator('dialog[open]').count())await page.getByRole('button',{name:'Later',exact:true}).click();
    assert.equal(await page.locator('[data-plugin=millsDisplay]').count(),0);
    await page.getByText('Optional integrations',{exact:true}).click();
    await page.getByRole('button',{name:'Configure Mills Display Wake'}).click();
    await page.getByRole('checkbox',{name:'Keep display awake during Mills playback'}).check();
    await page.getByRole('button',{name:'Save / Update'}).click();
    await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Saved revision'));
    assert.equal((await store.read()).document.plugins.millsDisplay.enabled,true);
    assert.equal(await page.locator('dialog[open]').count(),0);

  } finally { await browser.close(); }
});
