import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeMasterConfiguration} from '../src/lib/master-configuration.mjs';
import {readAlexaEventState,writeAlexaEventState} from '../src/lib/alexa-event-state.mjs';

test('Alexa observations persist independently without changing master configuration bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-alexa-events-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'config.json'),document=initializeMasterConfiguration();
  document.plugins.alexa.artistAliases={heard:'correct'};
  document.plugins.alexa.heardArtists=[{artist:'Historical'}];
  const bytes=JSON.stringify(document);await fs.writeFile(file,bytes);
  const current=await readAlexaEventState(file,{dataRoot:root});
  const next={...current,alexa:{...current.alexa,heardArtists:[{artist:'New'},...current.alexa.heardArtists]}};
  await writeAlexaEventState(file,next);
  assert.equal(await fs.readFile(file,'utf8'),bytes);
  const reread=await readAlexaEventState(file,{dataRoot:root});
  assert.deepEqual(reread.alexa.heardArtists,[{artist:'New'},{artist:'Historical'}]);
  assert.equal(reread.alexa.artistAliases,undefined);
  assert.equal((await fs.readFile(path.join(root,'alexa-events.json'),'utf8')).includes('artistAliases'),false);
});
