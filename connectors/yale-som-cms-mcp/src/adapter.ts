import { CmsBrowser } from "./browser.js";
import { CmsReads } from "./reads.js";
import { CmsMutations, mutationAreas } from "./mutations.js";
import type { CmsAdapter, Change, ReadRequest, RecordEffect, Area } from "./types.js";

/** The only live adapter: all operations stay within explicit CMS modules. */
export class BrowserAdapter implements CmsAdapter {
  readonly reads: CmsReads;
  readonly mutations: CmsMutations;
  constructor(readonly browser: CmsBrowser) {
    this.reads = new CmsReads(browser);
    this.mutations = new CmsMutations(browser, this.reads);
  }
  identity() { return this.browser.identity(); }
  read(input: ReadRequest) { return this.reads.read(input); }
  form(change: Change) { return this.mutations.form(change); }
  async capabilities() {
    return {
      ...await this.reads.capabilities(),
      mutation_operations: mutationAreas,
      mutation_support: "Account- and record-dependent. Call cms_get_form for the exact record; unavailable or unrecognized controls fail closed.",
      authentication: "Interactive login in a dedicated persistent Chrome profile; headless Chrome reuses that profile.",
      preview: "Local draft only; no field edits or uploads until explicit confirmation.",
      confirmation_ttl_seconds: 600
    };
  }
  prepare(change: Change) { return this.mutations.prepare(change); }
  submit(change: Change, recordEffect: RecordEffect) { return this.mutations.submit(change, recordEffect); }
  download(input: {area: Area; id: string; filename?: string}) { return this.reads.download(input); }
  close() { return this.browser.close(); }
}
