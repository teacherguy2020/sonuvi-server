import { MasterConfigurationDraft } from './master-configuration-draft.mjs';

/** Schema-driven built-in plugin editor. Transport comes from the existing session. */
export async function mountMasterConfigurationEditor(root, {request, refreshMs = 15000}) {
  const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const message = element('p'); message.setAttribute('role','status');
  const panels = element('div');
  panels.className = 'plugin-grid';
  const heading = element('h2','Master JSON');
  const json = element('textarea'); json.rows = 28; json.spellcheck = false; json.setAttribute('aria-label','Complete master configuration JSON'); json.style.width = '100%';
  const save = element('button','Save / Update'); save.type = 'button';
  const reload = element('button','Load server version'); reload.type = 'button';
  root.replaceChildren(message, panels, heading, json, save, reload);
  const loaded = await request('GET','');
  const draft = new MasterConfigurationDraft(loaded);
  const pendingPlugins = new Map();
  const credentialDraft = {apiKey:'',apiSecret:''};
  const otherCredentials = {};
  const credentialsDirty = () => Boolean(credentialDraft.apiKey || credentialDraft.apiSecret || Object.values(otherCredentials).some(fields=>Object.keys(fields).length));
  let authorizationUrl = '', credentialBusy = false, lastfmMessage = '';
  const lastfmError = error => ({
    EACCES: 'Server cannot save Last.fm credentials. The credential storage permissions need repair.',
    lastfm_api_key_and_secret_required: 'Enter both a valid API key and a different API secret, then save them.',
    lastfm_api_credentials_required: 'Save your API key and secret before connecting Last.fm.',
    lastfm_authorization_expired: 'Choose Connect Last.fm, open the authorization link and approve access, then complete authorization.'
  }[error.message] || error.message);
  let saving = false, disposed = false;
  let restarting = false;
  const restartButton=element('button','Restart Server');restartButton.type='button';
  root.append(restartButton);
  const restartDialog=element('dialog');restartDialog.setAttribute('aria-label','Server restart required');
  const restartTitle=element('h2','Server restart required');
  const restartStatus=element('p');restartStatus.setAttribute('role','status');
  const restartNow=element('button','Restart now');restartNow.type='button';
  const restartLater=element('button','Later');restartLater.type='button';
  restartDialog.append(restartTitle,restartStatus,restartNow,restartLater);
  restartDialog.style.cssText='max-width:480px;width:calc(100% - 48px);box-sizing:border-box;border-radius:14px;padding:24px;font:16px system-ui;color-scheme:dark light';
  for(const button of [restartNow,restartLater])button.style.cssText='font:inherit;padding:10px 16px;margin:8px 12px 0 0;cursor:pointer';
  // The app shell grows its iframe to the entire document height. A dialog in
  // that iframe would be centered far outside the visible screen.
  let dialogDocument=document;try{if(window.parent.location.origin===location.origin)dialogDocument=window.parent.document;}catch{}
  dialogDocument.body.append(restartDialog);
  window.addEventListener('pagehide',()=>{disposed=true;restartDialog.remove();},{once:true});
  const promptRestart=()=>{
    restartTitle.textContent='Server restart required';
    restartStatus.textContent='Your changes are saved, but a restart is needed to apply them. Restarting Sonuvi briefly disconnects this page and connected apps. You can restart now or choose Later and use Restart Server when ready.';
    restartNow.hidden=false;restartNow.disabled=false;restartLater.textContent='Later';
    if(!restartDialog.open)restartDialog.showModal();
  };
  restartButton.addEventListener('click',promptRestart);
  restartLater.addEventListener('click',()=>restartDialog.close());
  restartDialog.addEventListener('cancel',event=>{if(restarting)event.preventDefault();});
  restartNow.addEventListener('click',async()=>{
    if(restarting)return;
    if(draft.dirty || pendingPlugins.size || credentialsDirty()){
      restartStatus.textContent='Save or discard your remaining edits before restarting. Your saved settings are safe.';return;
    }
    restarting=true;restartNow.disabled=true;restartLater.disabled=true;
    try{
      restartStatus.textContent='Checking restart availability…';
      const before=await request('GET','/restart/status');
      if(!before.available)throw new Error(before.reason || 'Restart is unavailable on this Server.');
      const accepted=await request('POST','/restart',{});
      if(!accepted.restartAccepted)throw new Error('The Server did not accept the restart.');
      restartStatus.textContent='Restart requested. Waiting for Sonuvi to reconnect…';
      const deadline=Date.now()+60000;let recovered=false;
      while(Date.now()<deadline && !disposed){
        await new Promise(resolve=>setTimeout(resolve,1500));
        try{
          const after=await request('GET','/restart/status');
          if(after.available && after.instanceId && after.instanceId!==before.instanceId){recovered=true;break;}
        }catch{/* A brief disconnect is expected while both services restart. */}
      }
      if(!recovered)throw new Error('Restart recovery could not be confirmed. Your settings are saved. Wait briefly and reload; do not assume the restart completed.');
      restartTitle.textContent='Server restarted';restartStatus.textContent='Sonuvi has reconnected. Your saved settings are now applied.';
      restartNow.hidden=true;message.textContent='Server restarted and reconnected.';
    }catch(error){restartStatus.textContent=error.message;}
    finally{restarting=false;restartNow.disabled=false;restartLater.disabled=false;restartLater.textContent='Close';}
  });

  const render = () => {
    const openPanels = new Set([...panels.querySelectorAll('details[open]')].map(node=>node.closest('fieldset').dataset.plugin+':'+node.querySelector('summary').textContent));
    panels.replaceChildren();
    for (const module of loaded.plugins) {
      const section = element('fieldset'), legend = element('legend',module.title);
      section.className = 'plugin-card';
      section.dataset.plugin = module.id;
      section.append(legend);
      section.append(element('small',`sonuvi.${module.id} · Built-in`));
      const enabled = draft.document.plugins?.[module.id]?.enabled;
      section.append(element('p',enabled === undefined ? 'Core capability' : enabled ? 'Enabled' : 'Disabled'));
      const status = loaded.status?.[module.id];
      section.append(element('p',module.id==='alexa' ? `Public domain saved: ${status?.configured ? 'yes' : 'no'} · Playback: not verified${status?.error ? ' · '+status.error : ''}` : status ? `Configured: ${status.configured ?? 'unknown'} · Operational: ${status.operational ?? 'not checked'}${status.error ? ' · '+status.error : ''}` : 'Operational status has not been checked.'));
      if(module.id==='alexa'){
        section.append(element('p',status?.guidance || 'A saved domain is not proof of public HTTPS readiness.'));
        const connection=element('p',`Alexa setup: ${status?.setupState || 'not-checked'}`);connection.setAttribute('role','status');section.append(connection);
        const check=element('button','Check Alexa connection');check.type='button';section.append(check);
        check.addEventListener('click',async()=>{
          if(draft.dirty||pendingPlugins.size){connection.textContent='Save your settings before checking the connection.';return;}
          check.disabled=true;connection.textContent='Checking public DNS, HTTPS certificate, and API response…';
          try{const result=await request('POST','/plugins/alexa/check',{});loaded.status??={};loaded.status.alexa={...loaded.status.alexa,...result};render();}
          catch(error){connection.textContent=error.message;}
          finally{check.disabled=false;}
        });
      }
      const settings = element('details');
      settings.append(element('summary','Plugin Config'));
      for (const [key, schema] of Object.entries(module.schema.properties)) {
        if(schema.deprecated)continue;
        const label = element('label',key+' ');
        const value = draft.document.plugins?.[module.id]?.[key];
        let control;
        if (schema.enum) {
          control = element('select');
          for (const choice of schema.enum) { const option = element('option',choice); option.value = choice; control.append(option); }
          control.value = value ?? '';
        } else if (schema.type === 'object') {
          control = element('textarea'); control.value = JSON.stringify(value ?? {},null,2);
        } else {
          control = element('input');
          control.type = schema.type === 'boolean' ? 'checkbox' : schema.type === 'integer' ? 'number' : 'text';
          if (schema.type === 'boolean') control.checked = value === true; else control.value = value ?? '';
          if (schema.minimum !== undefined) control.min = schema.minimum;
          if (schema.maximum !== undefined) control.max = schema.maximum;
        }
        control.disabled = Boolean(draft.error) || pendingPlugins.size > 0;
        control.addEventListener('change',()=>{
          try {
            const next = schema.type === 'boolean' ? control.checked : schema.type === 'integer' ? Number(control.value) : schema.type === 'object' ? JSON.parse(control.value) : control.value;
            draft.editPlugin(module.id,key,next); json.value = draft.text; render(); message.textContent = 'Unsaved changes';
          } catch (error) { message.textContent = error.message; }
        });
        label.append(control); settings.append(label,element('br'));
      }
      section.append(settings);
      if(['apns','notifications','alexa'].includes(module.id)){
        const account=element('details');account.append(element('summary','Protected credentials'));
        const fields=module.id==='alexa'?['routeWebhookUrl','stopWebhookUrl']:module.credentials;
        account.append(element('p','Saved values are hidden, not missing. No need to enter saved values again. These explicit credential actions save immediately, outside exported JSON. Untouched fields retain their values; clearing an edited field removes it. Restart applies provider changes.'));
        if(module.id==='apns')account.append(element('p','Use credentials for your own Apple developer provider. Sonuvi’s private signing key is not included. Consumer push may require a separately operated Sonuvi push relay. Device registration and actual delivery are separate checks.'));
        for(const key of fields){
          const label=element('label',key+' '),input=element(key==='privateKey'?'textarea':'input');
          if(key!=='privateKey')input.type='password';else input.rows=5;
          const saved=loaded.status?.[module.id]?.credentials?.[key];
          input.placeholder=saved===true?'Saved ••••••••':saved===false?'Not saved':'Status unavailable';
          input.value=otherCredentials[module.id]?.[key]??'';input.autocomplete='new-password';
          input.addEventListener('input',()=>{otherCredentials[module.id]??={};otherCredentials[module.id][key]=input.value;});
          label.append(input,element('span',saved===true?' Saved':saved===false?' Not saved':' Saved status unavailable'));account.append(label,element('br'));
        }
        const button=element('button','Save '+module.title+' credentials');button.type='button';button.disabled=credentialBusy;
        button.addEventListener('click',async()=>{
          if(credentialBusy)return;credentialBusy=true;button.disabled=true;
          try{const result=await request('POST','/plugins/'+module.id+'/credentials',otherCredentials[module.id]||{});otherCredentials[module.id]={};loaded.status??={};loaded.status[module.id]=result;message.textContent='Credentials saved. Restart Server to apply provider changes.';if(result.restartRequired)promptRestart();}
          catch(error){message.textContent=error.message;}finally{credentialBusy=false;render();}
        });account.append(button);section.append(account);
      }
      if(module.id==='qobuz'){
        section.id='qobuzAccountSection';
        const connect=element('button','Connect Qobuz');connect.id='qobuzAccountConnectBtn';connect.disabled=true;section.append(connect);
        section.append(element('p','Account linking requires a supported authorization mechanism. Do not enter a Qobuz password or token here.'));
        const resultText=element('p','Qobuz account and renderer status have not been checked.');resultText.setAttribute('role','status');
        for(const [title,method,suffix] of [['Refresh status','GET','/plugins/qobuz/account/status'],['Release Qobuz session','POST','/plugins/qobuz/session/release']]){
          const button=element('button',title);button.type='button';if(method==='POST')button.id='qobuzSessionReleaseBtn';
          button.addEventListener('click',async()=>{
            if(method==='POST'&&!window.confirm('Stop the current Qobuz renderer session and return ownership to Sonuvi/MPD? This does not sign out the account.'))return;
            button.disabled=true;
            try{const result=await request(method,suffix,method==='POST'?{}:undefined);resultText.textContent=result.reason||result.state||'Status received';}
            catch(error){resultText.textContent=error.message;}finally{button.disabled=false;}
          });section.append(button);
        }
        section.append(resultText);
      }
      if(module.id==='moode'){
        const help=element('details');help.append(element('summary','Local display setup'));
        help.append(element('p','In moOde Configure → Peripherals → Local Display, use the portless HTTPS target https://sonuvi.local/display.html?mode=index&kiosk=1.'));
        help.append(element('p','The matching moOde maintenance bundle updates /var/www/daemon/worker.php, /var/www/daemon/watchdog.sh and /usr/local/bin/rgb_moode_service.py for wake/blanking and Mills LED behavior. Settings does not replace player daemon files.'));
        help.append(element('p','If the Server or target changed, pair the display/LED session with the new Server. Remote target verification has not been performed.'));
        section.append(help);
      }
      if(['hardware','mills','seeburg','multiphone'].includes(module.id)){
        section.append(element('p','Hardware may connect through a Pico, Mac, or other external bridge. Configure the shared Hardware / External Bridges listener and exact client roles; Mills also uses Harmony. Saving Server settings does not update bridge firmware, cabling, or credentials.'));
      }
      if(module.id==='lastfm'){
        const account=element('details');account.append(element('summary','Vibe, shelves and scrobbling'));
        account.append(element('p','API credentials are stored separately from exported configuration. These explicit account actions save immediately.'));
        account.append(element('p',status?.authorized ? `Authorized account: ${status.username || 'connected'}` : 'Connect Last.fm once for personal shelves and scrobbling. Vibe uses the API key without account authorization. Migrated shelf usernames remain a compatibility fallback.'));
        account.append(element('p',`API key: ${status?.apiKeyConfigured ? 'saved' : 'not saved'} · API secret: ${status?.apiSecretConfigured ? 'saved' : 'not saved'}. Saved values are hidden.`));
        if(status?.apiKeyConfigured && status?.apiSecretConfigured) account.append(element('p','Your API credentials are saved. No need to enter them again. To replace them, enter both a new key and secret.'));
        const feedback=element('p',lastfmMessage);feedback.setAttribute('role','status');account.append(feedback);
        for(const key of ['apiKey','apiSecret']){
          const label=element('label',key==='apiKey'?'API key ':'API secret '),input=element('input');
          input.type='password';input.autocomplete='new-password';input.value=credentialDraft[key];
          input.placeholder=status?.[key+'Configured'] ? 'Saved ••••••••' : (key==='apiKey' ? 'Enter API key' : 'Enter API secret');
          input.addEventListener('input',()=>{credentialDraft[key]=input.value;});
          label.append(input);account.append(label,element('br'));
        }
        for(const [action,title] of [['credentials','Save API credentials'],['authorize/start','Connect Last.fm'],['authorize/complete','Complete authorization'],['disconnect','Disconnect Last.fm']]){
          const button=element('button',title);button.type='button';button.disabled=credentialBusy;
          button.addEventListener('click',async()=>{
            if(credentialBusy)return;
            credentialBusy=true;button.disabled=true;feedback.textContent='Working…';
            try{
              const result=await request('POST','/plugins/lastfm/'+action,action==='credentials'?{...credentialDraft}:{});
              if(result.authorizationUrl){authorizationUrl=result.authorizationUrl;lastfmMessage='Open Last.fm authorization below, approve access, then choose Complete authorization.';}
              else{
                loaded.status??={};loaded.status.lastfm=result;
                if(action==='credentials'){credentialDraft.apiKey='';credentialDraft.apiSecret='';}
                authorizationUrl='';lastfmMessage=result.restartRequired?'Account settings saved. Restart Server to apply startup credentials.':'Account settings saved.';if(result.restartRequired)promptRestart();
              }
            }catch(error){lastfmMessage=lastfmError(error);}
            finally{credentialBusy=false;render();}
          });account.append(button);
        }
        if(authorizationUrl){const link=element('a','Open Last.fm authorization');link.href=authorizationUrl;link.target='_blank';link.rel='noopener noreferrer';account.append(link);account.open=true;}
        section.append(account);
      }
      const details = element('details'), summary = element('summary','JSON Config');
      const pluginJSON = element('textarea'); pluginJSON.rows = 8; pluginJSON.style.width='100%';
      pluginJSON.value = pendingPlugins.get(module.id) ?? JSON.stringify(draft.document.plugins?.[module.id],null,2);
      pluginJSON.disabled = Boolean(draft.error);
      pluginJSON.addEventListener('input',()=>{
        pendingPlugins.set(module.id,pluginJSON.value);
        message.textContent='Unsaved plugin JSON. Finish editing to validate.';
      });
      pluginJSON.addEventListener('change',()=>{
        try {
          const value = JSON.parse(pluginJSON.value);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin configuration must be an object');
          const next = structuredClone(draft.document); next.plugins[module.id] = value;
          pendingPlugins.delete(module.id);
          draft.editJSON(JSON.stringify(next,null,2)); json.value = draft.text; render(); message.textContent='Unsaved changes';
        } catch(error) { message.textContent=error.message; }
      });
      details.append(summary,pluginJSON); section.append(details);
      for(const detail of section.querySelectorAll('details'))if(openPanels.has(module.id+':'+detail.querySelector('summary').textContent))detail.open=true;
      panels.append(section);
    }
  };
  json.value = draft.text; render(); message.textContent = `Loaded revision ${draft.revision}`;
  json.addEventListener('input',()=>{
    if(pendingPlugins.size){message.textContent='Correct pending plugin JSON before editing the master document.';json.value=draft.text;return;}
    draft.editJSON(json.value); render();
    message.textContent = draft.error || 'Unsaved changes';
  });
  save.addEventListener('click',async()=>{
    if (saving) return;
    try {
      if(pendingPlugins.size) throw new Error('Correct pending plugin JSON before saving.');
      const pending = draft.saveRequest(); saving=true; save.disabled=true;
      await request('POST','/validate',{document:pending.document});
      const result = await request('PUT','',{document:pending.document,revision:pending.revision});
      draft.savedResponse(result,pending); if(result.setup?.alexa){loaded.status??={};loaded.status.alexa={...loaded.status.alexa,...result.setup.alexa};} json.value=draft.text; render();
      message.textContent=`Saved revision ${result.revision}. ${result.application?.error || (result.application?.restartRequired ? 'Server restart required.' : 'Applied.')} ${draft.dirty ? 'Newer unsaved edits remain.' : ''}`;
      if(result.setup?.alexa?.enabled)message.textContent+=' Alexa public HTTPS setup must be verified separately; use Check Alexa connection.';
      if(result.application?.restartRequired)promptRestart();
    } catch(error) { message.textContent=error.message; }
    finally { saving=false; save.disabled=false; }
  });
  reload.addEventListener('click',async()=>{
    if ((draft.dirty || pendingPlugins.size || credentialsDirty()) && !window.confirm('Discard your unsaved configuration edits and load the server version?')) return;
    try { const result=await request('GET',''); pendingPlugins.clear(); draft.replace(result.document,result.revision); Object.assign(loaded,result); json.value=draft.text; render(); message.textContent=`Loaded revision ${draft.revision}`; }
    catch(error) { message.textContent=error.message; }
  });
  const leave = event => { if(draft.dirty || pendingPlugins.size || credentialsDirty()){event.preventDefault();event.returnValue='';} };
  window.addEventListener('beforeunload',leave);
  let timer;
  const refresh = async()=>{
    if(disposed)return;
    try {
      if(!saving && !credentialBusy && !restarting && !credentialsDirty() && !pendingPlugins.size){const result=await request('GET',''); draft.receive(result); Object.assign(loaded,result);
        if(draft.external) message.textContent='Configuration changed elsewhere. Your draft is preserved; reconcile it before saving.';
        else if(!draft.dirty){json.value=draft.text;render();}}
    } catch(error){message.textContent=`Refresh failed: ${error.message}. Your draft is preserved.`;}
    finally {if(!disposed)timer=setTimeout(refresh,refreshMs);}
  };
  timer=setTimeout(refresh,refreshMs);
  return {draft,dispose(){disposed=true;restartDialog.remove();clearTimeout(timer);window.removeEventListener('beforeunload',leave);}};
}
