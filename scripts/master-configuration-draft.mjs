/** Editor state shared by forms and JSON. No network or persistence side effects. */
export class MasterConfigurationDraft {
  constructor({document, revision}) {
    this.saved = structuredClone(document);
    this.document = structuredClone(document);
    this.revision = revision;
    this.text = JSON.stringify(document, null, 2);
    this.error = null;
    this.external = null;
    this.generation = 0;
  }
  get dirty() { return this.text !== JSON.stringify(this.saved, null, 2); }
  editJSON(text) {
    this.text = text;
    this.generation++;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be an object');
      this.document = parsed;
      this.error = null;
      return true;
    } catch (error) { this.error = error.message; return false; }
  }
  editPlugin(id, key, value) {
    if (this.error) throw new Error('Correct the JSON error before editing form fields');
    if ([id,key].some(part=>['__proto__','prototype','constructor'].includes(part))) throw new Error('Invalid property');
    if (!this.document.plugins?.[id]) throw new Error('Plugin is missing from the draft');
    this.document.plugins[id][key] = structuredClone(value);
    this.text = JSON.stringify(this.document, null, 2);
    this.generation++;
  }
  receive({document,revision}) {
    if (revision === this.revision) return;
    if (this.dirty) { this.external = {document:structuredClone(document),revision}; return; }
    this.replace(document, revision);
  }
  replace(document,revision) {
    this.saved = structuredClone(document);
    this.document = structuredClone(document);
    this.text = JSON.stringify(document,null,2);
    this.revision = revision;
    this.error = null;
    this.external = null;
    this.generation++;
  }
  saveRequest() {
    if (this.error) throw new Error(this.error);
    if (this.external) throw new Error('Configuration changed elsewhere; reconcile the draft before saving');
    return {document:structuredClone(this.document),revision:this.revision,generation:this.generation};
  }
  savedResponse(response,request) {
    // A slow save must not discard edits made while it was in flight.
    if (this.generation === request.generation) this.replace(response.document,response.revision);
    else {
      this.saved = structuredClone(response.document);
      this.revision = response.revision;
      if (this.external?.revision === response.revision) this.external = null;
    }
  }
}
