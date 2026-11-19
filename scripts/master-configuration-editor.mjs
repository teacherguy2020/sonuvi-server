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
  const optional=element('details');optional.append(element('summary','Optional integrations'));
  const optionalChoices=element('div');optional.append(optionalChoices);
  message.className='configuration-status';optional.className='optional-integrations';
  const advanced=element('details');advanced.className='advanced-settings';advanced.append(element('summary','Advanced · Master JSON'),element('p','Forms and JSON edit the same draft. Save / Update commits your changes.'),heading,json);
  const actions=element('div');actions.className='configuration-actions';save.className='primary';actions.append(save,reload);
  const toolbar=element('div');toolbar.className='collection-toolbar';
  const filters=element('div');filters.className='collection-filters';filters.setAttribute('aria-label','Integration categories');
  const search=element('input');search.type='search';search.placeholder='Find an integration';search.setAttribute('aria-label','Find an integration');search.className='collection-search';
  const addIntegration=element('button','＋ Add integration');addIntegration.type='button';
  addIntegration.addEventListener('click',()=>{optional.open=true;optional.scrollIntoView({behavior:'smooth',block:'center'});optional.querySelector('summary').focus();});
  toolbar.append(filters,search,addIntegration);
  const empty=element('p','No integrations match your search.');empty.className='collection-empty';empty.hidden=true;
  root.replaceChildren(message,toolbar,panels,empty,optional,advanced,actions);
  const expanded=new Set();let category='All integrations';
  const descriptions={
    moode:['Devices','◉','Your home audio system. Playback and local display.'],mpd:['Devices','◉','The playback engine behind your listening queue.'],
    lastfm:['Music services','♫','A listening history that follows you. Scrobbling and discovery.'],alexa:['Devices','◌','Your music, hands-free. Voice control for your home.'],
    library:['System','▤','Bring your collection together. Folders, sources, and indexing.'],artwork:['Experience','▧','Give every record its cover. Artwork sources and motion.'],ratings:['Experience','☆','Make your favorites count. Your taste, remembered.'],
    display:['Experience','▧','Shape what appears on your listening screens.'],playback:['Experience','▷','Your queue, playlists, and playback preferences.'],
    notifications:['Experience','♧','Stay in tune with what is playing.'],apns:['Experience','♧','Deliver listening updates to your Apple devices.'],
    radio:['Music services','♫','Stations and discoveries for every listening mood.'],qobuz:['Music services','♫','Your Qobuz account and listening session.'],podcasts:['Music services','♫','Keep your favorite shows close at hand.'],appleMusic:['Music services','♫','Enrich your collection with Apple Music metadata.'],
    upnp:['Devices','⌘','Music sources and players on your home network.'],dlna:['Devices','⌘','Share your library with compatible home players.'],echoLink:['Devices','◉','Connect your Echo Link listening setup.'],
    hardware:['Custom','⌘','Connections for your external hardware bridges.'],mills:['Custom','◉','Your Mills jukebox collection and playback.'],seeburg:['Custom','◉','Your Seeburg jukebox connection.'],multiphone:['Custom','◉','Your Shyvers Multiphone and Mabel setup.'],millsDisplay:['Custom','▧','Keep your moOde screen awake while Mills plays.'],harmony:['Custom','⌘','Coordinate your amplifier and listening inputs.']
  };
  const applyFilter=()=>{let visible=0;for(const card of panels.children){card.hidden=(category!=='All integrations'&&card.dataset.category!==category)||!card.dataset.search.includes(search.value.toLowerCase().trim());if(!card.hidden)visible++;}empty.hidden=visible>0;};
  for(const name of ['All integrations','Music services','Devices','Experience','System','Custom']){const button=element('button',name);button.type='button';button.setAttribute('aria-pressed',String(category===name));button.addEventListener('click',()=>{category=name;for(const item of filters.children)item.setAttribute('aria-pressed',String(item===button));applyFilter();});filters.append(button);}
  search.addEventListener('input',applyFilter);
  const loaded = await request('GET','');
  const draft = new MasterConfigurationDraft(loaded);
  const pendingPlugins = new Map();
  const shownOptional=new Set();
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
  actions.append(restartButton);
  const restartDialog=element('dialog');restartDialog.setAttribute('aria-label','Server restart required');
  const restartTitle=element('h2','Server restart required');
  const restartStatus=element('p');restartStatus.setAttribute('role','status');
  const restartNow=element('button','Restart now');restartNow.type='button';
  const restartLater=element('button','Later');restartLater.type='button';
  restartDialog.append(restartTitle,restartStatus,restartNow,restartLater);
  restartDialog.style.cssText='max-width:480px;width:calc(100% - 48px);box-sizing:border-box;border-radius:14px;padding:24px;font:16px system-ui;background:var(--theme-hero-card-bg,rgba(10,18,34,.95));color:var(--theme-text,#e7eefc);border:1px solid var(--theme-rail-border,#2a3a58)';
  for(const button of [restartNow,restartLater])button.style.cssText='font:inherit;padding:10px 16px;margin:8px 12px 0 0;cursor:pointer;background:var(--theme-tab-bg,#0f1a31);color:var(--theme-tab-text,#e7eefc);border:1px solid var(--theme-rail-border,#2a3a58);border-radius:7px';
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
    const openPanels = new Set([...panels.querySelectorAll('details[open]')].map(node=>node.closest('.plugin-card').dataset.plugin+':'+node.querySelector('summary').textContent));
    panels.replaceChildren();optionalChoices.replaceChildren();
    const featured=['moode','lastfm','alexa','library','artwork','ratings'];
    const order=id=>featured.includes(id)?featured.indexOf(id):featured.length;
    for (const module of [...loaded.plugins].sort((a,b)=>order(a.id)-order(b.id))) {
      const custom=['hardware','mills','seeburg','multiphone','harmony'].includes(module.id);
      const customActive=draft.document.plugins?.[module.id]?.enabled || (['mills','seeburg','multiphone'].includes(module.id) && draft.document.plugins?.hardware?.enabled);
      if(((module.optional && !draft.document.plugins?.[module.id]?.enabled)||(custom && !customActive)) && !shownOptional.has(module.id)){
        const add=element('button','Configure '+module.title);add.type='button';
        add.addEventListener('click',()=>{shownOptional.add(module.id);expanded.add(module.id);category='All integrations';search.value='';for(const item of filters.children)item.setAttribute('aria-pressed',String(item.textContent===category));render();});optionalChoices.append(add);continue;
      }
      let section = element('section');const title = element('h2',module.title);
      title.className='card-title';title.id='config-title-'+module.id;
      section.setAttribute('aria-labelledby',title.id);
      section.className = 'plugin-card';
      section.dataset.plugin = module.id;
      const [group,icon,description]=descriptions[module.id]||['System','⌘','Manage this part of your Sonuvi setup.'];
      section.dataset.category=group;section.dataset.search=(module.title+' '+description+' '+group).toLowerCase();
      const symbol=element('span',icon);symbol.className='card-icon';symbol.setAttribute('aria-hidden','true');
      const badge=element('span');badge.className='card-badge';
      const blurb=element('p',description);blurb.className='card-description';
      const footer=element('div');footer.className='card-footer';
      const configure=element('button',expanded.has(module.id)?'Close settings ↑':'Configure ↗');configure.type='button';configure.setAttribute('aria-label','Configure '+module.title);configure.setAttribute('aria-expanded',String(expanded.has(module.id)));configure.setAttribute('aria-controls','config-body-'+module.id);
      footer.append(element('span',group==='Custom'?'Custom integration':group),configure);
      const header=element('div');header.className='card-header';header.append(symbol,badge);
      section.append(header,title,blurb,footer);
      const card=section;
      const body=element('div');body.className='card-body';body.id='config-body-'+module.id;body.hidden=!expanded.has(module.id);card.classList.toggle('expanded',!body.hidden);card.append(body);
      configure.addEventListener('click',()=>{body.hidden=!body.hidden;body.hidden?expanded.delete(module.id):expanded.add(module.id);card.classList.toggle('expanded',!body.hidden);configure.setAttribute('aria-expanded',String(!body.hidden));configure.textContent=body.hidden?'Configure ↗':'Close settings ↑';});
      section=body;
      section.append(element('small',`sonuvi.${module.id} · ${module.optional?'Optional':'Built-in'}`));
      const enabled = draft.document.plugins?.[module.id]?.enabled;
      section.append(element('p',enabled === undefined ? 'Core capability' : enabled ? 'Enabled' : 'Disabled'));
      const status = loaded.status?.[module.id];
      badge.textContent=enabled===false?'Disabled':status?.operational===true?'Verified':enabled===true?'Enabled':'Not checked';
      badge.title='Enablement is a saved preference; it does not imply a verified connection.';
      if(module.id!=='millsDisplay')section.append(element('p',module.id==='alexa' ? `Public domain saved: ${status?.configured ? 'yes' : 'no'} · Playback: not verified${status?.error ? ' · '+status.error : ''}` : status ? `Configured: ${status.configured ?? 'unknown'} · Operational: ${status.operational ?? 'not checked'}${status.error ? ' · '+status.error : ''}` : 'Operational status has not been checked.'));
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
        if(schema.deprecated || module.id==='millsDisplay')continue;
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
      if(module.id!=='millsDisplay')section.append(settings);
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
      if(module.id==='millsDisplay'){
        section.append(element('p','Optional integration for a physical Mills jukebox and a moOde screen. Not needed for ordinary Sonuvi playback. Disabled by default.'));
        const power=element('fieldset');power.append(element('legend','Physical jukebox display'));
        const label=element('label','Keep display awake during Mills playback '),toggle=element('input');toggle.type='checkbox';toggle.checked=draft.document.plugins?.millsDisplay?.enabled===true;toggle.setAttribute('aria-label','Keep display awake during Mills playback');
        toggle.addEventListener('change',()=>{draft.document.plugins.millsDisplay??={enabled:false};draft.editPlugin('millsDisplay','enabled',toggle.checked);json.value=draft.text;render();message.textContent='Unsaved changes — choose Save / Update. Display power changes apply without a restart.';});label.append(toggle);power.append(label);
        power.append(element('p','Uses a dedicated machine connection. When enabled, Mills playback wakes the screen; after playback ends, the normal moOde idle timeout applies. Turning this off does not disable ordinary playback wake behavior.'));
        const connection=loaded.status?.millsDisplay;
        power.append(element('p',connection?.connection==='receiving'?'Machine connection: receiving authenticated playback-state requests.':'Machine connection: not verified. Check that the moOde display connection is provisioned.'));
        power.append(element('p',connection?.enabled?'Saved Mills wake setting: enabled.':'Saved Mills wake setting: disabled.'));
        const check=element('button','Check display connection');check.type='button';check.addEventListener('click',async()=>{check.disabled=true;try{const fresh=await request('GET','');loaded.status=fresh.status;render();}catch(error){message.textContent='Connection check unavailable: '+error.message;}finally{check.disabled=false;}});power.append(check);section.append(power);

      }
      if(module.id==='moode'){
        const help=element('details');help.append(element('summary','Local display setup'));
        help.append(element('p','In moOde Configure → Peripherals → Local Display, use the portless HTTPS target https://sonuvi.local/display.html?mode=index&kiosk=1.'));
        help.append(element('p','The matching moOde maintenance bundle updates /var/www/daemon/worker.php, /var/www/daemon/watchdog.sh and /usr/local/bin/rgb_moode_service.py for wake/blanking and Mills LED behavior. Settings does not replace player daemon files.'));
        help.append(element('p','The browser display uses normal pairing. Display power uses a separate, narrowly scoped machine credential installed on moOde; browser cookies are not used for wake detection.'));
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
      panels.append(card);
    }
    optional.hidden=optionalChoices.children.length===0;addIntegration.hidden=optional.hidden;applyFilter();
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
      if(!saving && !credentialBusy && !restarting && !credentialsDirty() && !pendingPlugins.size && !root.contains(document.activeElement)){const result=await request('GET',''); draft.receive(result); Object.assign(loaded,result);
        if(draft.external) message.textContent='Configuration changed elsewhere. Your draft is preserved; reconcile it before saving.';
        else if(!draft.dirty){json.value=draft.text;render();}}
    } catch(error){message.textContent=`Refresh failed: ${error.message}. Your draft is preserved.`;}
    finally {if(!disposed)timer=setTimeout(refresh,refreshMs);}
  };
  timer=setTimeout(refresh,refreshMs);
  return {draft,dispose(){disposed=true;restartDialog.remove();clearTimeout(timer);window.removeEventListener('beforeunload',leave);}};
}
