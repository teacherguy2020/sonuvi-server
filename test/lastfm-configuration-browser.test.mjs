import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { initializeMasterConfiguration, createMasterConfigurationStore } from '../src/lib/master-configuration.mjs';
import {registerMasterConfigurationRoutes} from '../src/routes/master-configuration.routes.mjs';

import {createLastfmPluginAdministration} from '../src/lib/lastfm-plugin-admin.mjs';
import {createPublicWebServer} from '../src/lib/public-web-server.mjs';
import {buildPublicWebRoot} from '../src/lib/public-web-root.mjs';
test('actual configuration page synchronizes forms and JSON through real validation and atomic persistence', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-browser-master-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'config.json'),document=initializeMasterConfiguration();document.plugins.radio.enabled=false;
  await fs.writeFile(file,JSON.stringify(document));
  const store=createMasterConfigurationStore(file),routes=new Map();
  registerMasterConfigurationRoutes(Object.fromEntries(['get','put','post'].map(method=>[method,(path,handler)=>routes.set(method.toUpperCase()+' '+path,handler)])),{store,authorize:async()=>true,lastfm:createLastfmPluginAdministration({statePaths:{sharedStateEnabled:true,lastfmEnvPath:path.join(root,'legacy.env'),lastfmAdminEnvPath:path.join(root,'credentials.env')},env:{},requestToken:async()=>'fixture-token',exchangeToken:async()=>({sessionKey:'fixture-session',username:'fixture-user'})})});
  const publicRoot=process.env.PACKAGED_ROOT ? path.join(process.env.PACKAGED_ROOT,'public') : path.join(root,'public');if(!process.env.PACKAGED_ROOT)await buildPublicWebRoot({sourceRoot: new URL('../',import.meta.url).pathname,outputRoot:publicRoot});
  const server=await createPublicWebServer({publicRoot});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser = await chromium.launch({headless:true});
  try {
    const hostPage = await browser.newPage();
    let page=hostPage;
    let saves = 0, restarts = 0;
    await page.route(origin+'/**', async route => {
      const url = new URL(route.request().url());
      if(url.pathname.startsWith('/__controller/configuration')) {
        if(url.pathname.endsWith('/restart/status'))return route.fulfill({json:{ok:true,available:true,instanceId:restarts?'after':'before'}});
        if(url.pathname.endsWith('/restart')){restarts++;return route.fulfill({status:202,json:{ok:true,restartAccepted:true}});}
        const method=route.request().method(),target=url.pathname.replace('/__controller/configuration','/v1/admin/configuration/master');
        const handler=routes.get(method+' '+target);assert.ok(handler);
        const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
        await handler({body:method==='GET'?undefined:route.request().postDataJSON()},response);
        if(method==='PUT'&&response.body.ok)saves++;
        return route.fulfill({status:response.statusCode,json:response.body});
      }
      if(url.pathname==='/__controller/config.js' || url.pathname==='/scripts/controller-browser-auth.js') return route.fulfill({contentType:'text/javascript',body:''});
      return route.continue();
    });
    await hostPage.goto(origin+'/app.html?page=config.html');
    await hostPage.locator('#appFrame').waitFor();
    page=hostPage.frameLocator('#appFrame');
    const lastfm=page.locator('fieldset[data-plugin=lastfm]');
    await lastfm.locator('summary',{hasText:'Vibe, shelves and scrobbling'}).click();
    await lastfm.getByRole('button',{name:'Complete authorization',exact:true}).click();
    await lastfm.getByRole('status').filter({hasText:'Choose Connect Last.fm'}).waitFor();
    await lastfm.locator('input[type=password]').nth(0).fill('fixture-key');
    await lastfm.locator('input[type=password]').nth(1).fill('fixture-secret');
    await lastfm.getByRole('button',{name:'Save API credentials'}).click();
    await lastfm.getByText('API key: saved · API secret: saved.',{exact:false}).waitFor();
    await hostPage.getByRole('button',{name:'Later',exact:true}).click();
    assert.equal(restarts,0);
    await lastfm.getByRole('button',{name:'Connect Last.fm',exact:true}).click();
    await lastfm.getByRole('link',{name:'Open Last.fm authorization'}).waitFor();
    await lastfm.getByRole('button',{name:'Complete authorization',exact:true}).click();
    await lastfm.getByText('Authorized account: fixture-user').waitFor();
    await hostPage.getByRole('button',{name:'Later',exact:true}).click();
    assert.match(await fs.readFile(path.join(root,'credentials.env'),'utf8'),/LASTFM_SESSION_KEY=fixture-session/);
    const radio=page.locator('fieldset').filter({has:page.locator('legend',{hasText:/^Radio$/})});
    await radio.locator('summary',{hasText:'Plugin Config'}).click();
    await radio.locator('input[type=checkbox]').check();
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
    await page.locator('[role=status]').filter({hasText:'Saved revision'}).waitFor();
    assert.equal(saves,1);assert.equal((await store.read()).document.plugins.radio.enabled,true);
    await hostPage.getByRole('button',{name:'Restart now',exact:true}).click();
    await hostPage.getByRole('heading',{name:'Server restarted',exact:true}).waitFor();
    assert.equal(restarts,1);
  } finally { await browser.close(); }
});
