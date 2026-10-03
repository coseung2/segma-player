import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { get } from "svelte/store";
let sequence = 0;
async function harness(t, listLibrary) {
  const key = `__libraryStoreTest${++sequence}`;
  globalThis[key] = { listLibrary };
  t.after(() => { delete globalThis[key]; });
  const names = ["autoOrganizeLibrary", "deleteLibraryFile", "listLibrary", "moveLibraryFile", "openLibraryFolder", "revealLibraryFile", "updateLibraryMetadata"];
  const stub = `data:text/javascript,${encodeURIComponent(names.map((n) => `export const ${n} = (...args) => globalThis[${JSON.stringify(key)}].${n}(...args);`).join("\n"))}`;
  const source = await readFile(new URL("./stores/library.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolved = compiled.replace('from "../api"', `from ${JSON.stringify(stub)}`).replace('from "svelte/store"', `from ${JSON.stringify(import.meta.resolve("svelte/store"))}`);
  return import(`data:text/javascript,${encodeURIComponent(resolved)}`);
}
const listing = (...names) => ({ folder: null, folders: [], entries: names.map(fileName => ({fileName})), missingOutputCount: 0, usageBytes: 0 });

test("initial refresh does not supersede the first load or announce existing files as new", async (t) => {
  let finish; let calls = 0;
  const store = await harness(t, () => { calls++; return new Promise(r => { finish = r; }); });
  const initial = store.loadLibrary(null);
  await store.loadLibrary(null, true);
  assert.equal(calls, 1);
  finish(listing("existing.mp4")); await initial;
  assert.equal(get(store.libraryState).newEntryCount, 0);
  assert.equal(get(store.libraryState).data.entries.length, 1);
});

test("new file notice follows surviving files and clears when the new file is removed", async (t) => {
  let response = listing("old.mp4");
  const store = await harness(t, async () => response);
  await store.loadLibrary(null);
  response = listing("new.mp4", "old.mp4"); await store.loadLibrary(null, true);
  assert.deepEqual(get(store.libraryState).data.entries.map(e => e.fileName), ["old.mp4", "new.mp4"]);
  assert.equal(get(store.libraryState).newEntryCount, 1);
  await store.loadLibrary(null, true); assert.equal(get(store.libraryState).newEntryCount, 1);
  response = listing("old.mp4"); await store.loadLibrary(null, true);
  assert.equal(get(store.libraryState).newEntryCount, 0);
});
