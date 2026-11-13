import { configurationPlugins, validateMasterConfiguration, MasterConfigurationError } from '../lib/master-configuration.mjs';

/** One API for both editors. Authorization is supplied by the existing owner API. */
export function registerMasterConfigurationRoutes(app, {
  store, authorize, applyConfiguration, lastfm, credentials, pluginStatus = async () => ({}),
  prefix = '/v1/admin/configuration/master',
}) {
  if (!store || typeof authorize !== 'function') throw new Error('Master configuration requires store and authorization');
  const handler = action => async (req, res) => {
    try {
      if (await authorize(req, res) !== true) return;
      res.setHeader('Cache-Control', 'no-store');
      return await action(req, res);
    } catch (error) {
      return res.status(error.status || 500).json({ok:false, code:error.code || 'configuration_unavailable', errors:error.details || []});
    }
  };
  app.get(prefix, handler(async (req, res) => {
    const state = await store.read();
    const status=await pluginStatus(state.document);
    if(lastfm)status.lastfm={...lastfm.status(),enabled:state.document.plugins.lastfm.enabled};
    if(credentials){
      const plugins=state.document.plugins;
      const apns=credentials.status('apns'),push=credentials.status('notifications'),alexa=credentials.status('alexa');
      const providerConfigured=apns.configured&&Boolean(plugins.apns.topic.trim());
      status.apns={...apns,enabled:plugins.apns.enabled,configured:providerConfigured,
        error:plugins.apns.enabled&&!providerConfigured?'Configure the APNs signing credentials and application topic.':null};
      status.notifications={...push,enabled:plugins.notifications.enabled,
        configured:push.configured||(plugins.apns.enabled&&providerConfigured),
        capabilities:{pushover:{configured:push.configured,operational:null},apns:{configured:providerConfigured,enabled:plugins.apns.enabled,operational:null}}};
      const skillConfigured=Boolean(plugins.alexa.publicDomain.trim()&&plugins.alexa.webhookPath.trim());
      status.alexa={...alexa,enabled:plugins.alexa.enabled,configured:skillConfigured,
        capabilities:{skillEndpoint:{configured:skillConfigured,operational:null},homebridgeRouting:{configured:alexa.configured,operational:null}},
        error:plugins.alexa.enabled&&!skillConfigured?'Configure the public Alexa endpoint. External skill connectivity has not been verified.':null};
    }
    return res.json({ok:true, contract:'sonuvi.master-configuration.v1', ...state, plugins:configurationPlugins, status});
  }));
  app.post(`${prefix}/validate`, handler(async (req, res) => {
    const errors = validateMasterConfiguration(req.body?.document);
    return res.status(errors.length ? 422 : 200).json({ok:errors.length === 0, errors});
  }));
  if(lastfm){
    for(const action of ['credentials','authorize/start','authorize/complete','disconnect']){
      app.post(`${prefix}/plugins/lastfm/${action}`,handler(async(req,res)=>res.json({ok:true,...await lastfm.action(action,req.body)})));
    }
  }
  if(credentials)for(const id of ['apns','notifications','alexa'])app.post(`${prefix}/plugins/${id}/credentials`,handler(async(req,res)=>res.json({ok:true,...await credentials.save(id,req.body)})));
  app.put(prefix, handler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new MasterConfigurationError('configuration_request_invalid', 400);
    const before = await store.read();
    const saved = await store.save(req.body.document, req.body.revision);
    let application = {state:saved.changed ? 'restart-required' : 'unchanged', restartRequired:saved.changed};
    if (saved.changed && applyConfiguration) {
      try { application = await applyConfiguration({before:before.document, after:saved.document, revision:saved.revision}); }
      catch { application = {state:'apply-failed', restartRequired:true, error:'Settings were saved, but runtime application failed.'}; }
    }
    return res.json({ok:true, contract:'sonuvi.master-configuration.v1', ...saved, application});
  }));
}
