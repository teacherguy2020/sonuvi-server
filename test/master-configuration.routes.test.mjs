import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMasterConfigurationRoutes } from '../src/routes/master-configuration.routes.mjs';
import { initializeMasterConfiguration } from '../src/lib/master-configuration.mjs';

function harness(options) {
  const routes = new Map();
  const app = Object.fromEntries(['get','put','post'].map(method=>[method,(path,handler)=>routes.set(`${method} ${path}`,handler)]));
  registerMasterConfigurationRoutes(app,options);
  return async (method,path,body) => {
    const response = {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
    await routes.get(`${method} /v1/admin/configuration/master${path}`)({body},response);
    return response;
  };
}
test('plugin readiness distinguishes endpoint, provider topic and delivery capabilities from live operation',async()=>{
 const document=initializeMasterConfiguration();
 document.plugins.apns.enabled=true;document.plugins.alexa.enabled=true;
 document.plugins.alexa.publicDomain='example.test';
 const call=harness({authorize:async()=>true,store:{read:async()=>({document,revision:'fixture'})},credentials:{status:id=>({configured:id==='apns',operational:null})}});
 let status=(await call('get','')).body.status;
 assert.equal(status.apns.configured,false);assert.match(status.apns.error,/topic/);
 assert.equal(status.alexa.configured,true);assert.equal(status.alexa.operational,null);
 assert.equal(status.alexa.capabilities.homebridgeRouting.configured,false);
 document.plugins.apns.topic='test.sonuvi';
 status=(await call('get','')).body.status;
 assert.equal(status.notifications.configured,true);
 assert.equal(status.notifications.capabilities.pushover.configured,false);
 assert.equal(status.apns.operational,null);
});
test('master reads require authorization before touching configuration',async()=>{
  let reads = 0;
  const call = harness({store:{read:async()=>{reads++;}},authorize:async(req,res)=>{res.status(401).json({ok:false});return false;}});
  const response = await call('get','');
  assert.equal(response.statusCode,401);
  assert.equal(reads,0);
});
test('Last.fm credential actions require existing owner authorization before any mutation',async()=>{
  let mutations=0;
  const call=harness({store:{},authorize:async(req,res)=>{res.status(401).json({ok:false});return false;},lastfm:{action:async()=>{mutations++;}}});
  for(const action of ['credentials','authorize/start','authorize/complete','disconnect']){
    const result=await call('post','/plugins/lastfm/'+action,{});
    assert.equal(result.statusCode,401);
  }
  assert.equal(mutations,0);
});
test('saved-but-apply-failed is distinct from failed persistence',async()=>{
  const document = initializeMasterConfiguration();
  let writes = 0;
  const call = harness({authorize:async()=>true,store:{read:async()=>({document,revision:'before'}),save:async()=>{writes++;return {document,revision:'after',changed:true};}},applyConfiguration:async()=>{throw new Error('offline');}});
  const response = await call('put','',{document,revision:'before'});
  assert.equal(response.body.ok,true);
  assert.equal(response.body.revision,'after');
  assert.equal(response.body.application.state,'apply-failed');
  assert.equal(response.body.application.restartRequired,true);
  assert.equal(writes,1);
});
test('invalid whole-document validation provides actionable field locations',async()=>{
  const call = harness({authorize:async()=>true,store:{}});
  const document = initializeMasterConfiguration();
  document.plugins.mpd.port = 0;
  const response = await call('post','/validate',{document});
  assert.equal(response.statusCode,422);
  assert.ok(response.body.errors.some(e=>e.path==='/plugins/mpd/port'));
});
