import test from 'node:test';
import assert from 'node:assert/strict';
import { MasterConfigurationDraft } from '../scripts/master-configuration-draft.mjs';
const initial = () => ({document:{plugins:{radio:{enabled:true}}},revision:'one'});

test('forms and valid JSON edit the same draft without changing saved values',()=>{
  const draft = new MasterConfigurationDraft(initial());
  draft.editPlugin('radio','enabled',false);
  assert.equal(JSON.parse(draft.text).plugins.radio.enabled,false);
  assert.equal(draft.saved.plugins.radio.enabled,true);
  assert.equal(draft.editJSON('{"plugins":{"radio":{"enabled":true}}}'),true);
  assert.equal(draft.document.plugins.radio.enabled,true);
});
test('invalid JSON preserves last valid form state and cannot be saved',()=>{
  const draft = new MasterConfigurationDraft(initial());
  assert.equal(draft.editJSON('{invalid'),false);
  assert.equal(draft.document.plugins.radio.enabled,true);
  assert.throws(()=>draft.saveRequest());
  assert.throws(()=>draft.editPlugin('radio','enabled',false));
  assert.equal(draft.text,'{invalid');
});
test('external revisions do not discard unsaved work',()=>{
  const draft = new MasterConfigurationDraft(initial());
  draft.editPlugin('radio','enabled',false);
  draft.receive({document:{plugins:{radio:{enabled:true,extra:1}}},revision:'two'});
  assert.equal(draft.document.plugins.radio.enabled,false);
  assert.equal(draft.external.revision,'two');
  assert.throws(()=>draft.saveRequest(), /changed elsewhere/);
});
test('edits made during a save remain dirty after its response',()=>{
  const draft = new MasterConfigurationDraft(initial());
  draft.editPlugin('radio','enabled',false);
  const request = draft.saveRequest();
  draft.editPlugin('radio','enabled',true);
  draft.savedResponse({document:request.document,revision:'two'},request);
  assert.equal(draft.document.plugins.radio.enabled,true);
  assert.equal(draft.saved.plugins.radio.enabled,false);
  assert.equal(draft.dirty,true);
  assert.equal(draft.revision,'two');
});
