import fs from 'node:fs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import { MASTER_FORMAT } from '../lib/master-configuration.mjs';
import { installCanonicalRuntimeEnvironment } from '../lib/master-runtime-environment.mjs';
import { loadProtectedLastfmEnvironment } from '../lib/protected-runtime-secrets.mjs';
import {installPluginCredentialEnvironment} from '../lib/plugin-credentials.mjs';

const file=runtimeStatePaths().configPath;
if(fs.existsSync(file)){
  const document=JSON.parse(fs.readFileSync(file,'utf8'));
  if(document.format===MASTER_FORMAT){
    installCanonicalRuntimeEnvironment(document);
    Object.assign(process.env,loadProtectedLastfmEnvironment({statePaths:runtimeStatePaths()}));
    installPluginCredentialEnvironment(runtimeStatePaths());
  }
}
