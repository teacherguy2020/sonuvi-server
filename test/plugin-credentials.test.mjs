import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPluginCredentialAdministration,installPluginCredentialEnvironment} from '../src/lib/plugin-credentials.mjs';
import {createApnsProvider} from '../src/lib/apns.mjs';

test('plugin credentials retain unrelated fields, survive startup, and never appear in status',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-plugin-credentials-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const id of ['apns','notifications','alexa'])await fs.mkdir(path.join(root,'integrations',id),{recursive:true});
  const statePaths={secretsRoot:root},env={};
  const admin=createPluginCredentialAdministration({statePaths,env});
  await admin.save('notifications',{pushoverToken:'fixture-token'});
  const result=await admin.save('notifications',{pushoverUserKey:'fixture-user'});
  assert.equal(result.configured,true);assert.equal(result.restartRequired,true);
  assert.equal(JSON.stringify(result).includes('fixture-token'),false);
  installPluginCredentialEnvironment(statePaths,env);
  assert.equal(env.PUSHOVER_TOKEN,'fixture-token');assert.equal(env.PUSHOVER_USER_KEY,'fixture-user');
  assert.equal(admin.status('notifications').restartRequired,false);
  env.APNS_PRIVATE_KEY_PATH='/legacy/private-key.p8';
  await admin.save('apns',{privateKey:''});
  installPluginCredentialEnvironment(statePaths,env);
  assert.equal(env.APNS_PRIVATE_KEY_PATH,undefined);
  assert.equal(env.APNS_PRIVATE_KEY,'');
  await assert.rejects(admin.save('notifications',{TRACK_KEY:'bad'}),{code:'plugin_credentials_invalid'});
  await assert.rejects(admin.save('apns',{privateKey:'not a private key'}),{code:'apns_requires_p256_private_key'});
  await assert.rejects(admin.save('alexa',{routeWebhookUrl:'file:///private'}),{code:'alexa_webhook_url_invalid'});
  assert.equal((await fs.stat(path.join(root,'integrations','notifications','credentials.json'))).mode&0o777,0o600);
});

test('APNs sandbox selects development delivery and disabled providers send nothing',async()=>{
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});let calls=0;
  const options={keyId:'fixture',teamId:'fixture',topic:'test.topic',privateKey:privateKey.export({type:'pkcs8',format:'pem'}),environment:'sandbox',request:async request=>{calls++;assert.equal(request.authority,'https://api.sandbox.push.apple.com');return {status:200,headers:{},body:''};}};
  const event={deviceToken:'ab'.repeat(32),payload:{aps:{alert:'fixture'}}};
  assert.equal((await createApnsProvider(options).send(event)).ok,true);
  assert.equal((await createApnsProvider({...options,enabled:false}).send(event)).reason,'provider-disabled');
  assert.equal(calls,1);
});
