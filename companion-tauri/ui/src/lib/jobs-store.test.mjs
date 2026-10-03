import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { get } from "svelte/store";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const fixture = (overrides = {}) => ({ jobId: "test-job", jobType: "media", status: "running", active: true, paused: false, actions: ["cancel"], updatedAt: 1, ...overrides });
let sequence = 0;

// Exercise the real store with delayed IPC responses, without requiring a native window.
async function storeWith(t, api) {
  const key = `__jobsStoreTest${++sequence}`;
  globalThis[key] = api;
  t.after(() => { delete globalThis[key]; });
  const names = ["cancelJob", "listJobs", "pauseJob", "resumeJob", "retryJob", "resolveJobOutput", "revealJobOutput", "listLibrary", "removeJobHistory", "selectMedia"];
  const stub = `data:text/javascript,${encodeURIComponent(names.map((name) => `export const ${name} = (...args) => globalThis[${JSON.stringify(key)}].${name}(...args);`).join("\n"))}`;
  const source = await readFile(new URL("./stores/jobs.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = { "svelte/store": import.meta.resolve("svelte/store"), "../api": stub, "./player": stub, "../queue-policy": new URL("./queue-policy.ts", import.meta.url).href };
  const resolved = compiled.replace(/from "([^"]+)"/g, (_, name) => `from ${JSON.stringify(imports[name] ?? name)}`);
  return import(`data:text/javascript,${encodeURIComponent(resolved)}`);
}

test("cancel stays pending after acceptance, blocks duplicate clicks, then follows server state", async (t) => {
  let current = fixture();
  let cancellations = 0;
  const store = await storeWith(t, { listJobs: async () => ({ jobs: [current] }), cancelJob: async () => { cancellations++; return { accepted: true }; } });
  await store.loadJobs();
  await store.runJobAction(current, "cancel");
  assert.equal(get(store.jobsState).pending[current.jobId].action, "cancel");
  assert.equal(get(store.jobsState).jobs[0].status, "running");
  assert.equal(get(store.jobsState).notice, null);
  await store.runJobAction(current, "cancel");
  assert.equal(cancellations, 1);
  current = fixture({ status: "cancelled", active: false, updatedAt: 2 });
  await store.loadJobs(true);
  assert.equal(get(store.jobsState).pending[current.jobId], undefined);
});

test("a pre-deletion poll cannot restore a removed history entry", async (t) => {
  const oldPoll = deferred();
  const completed = fixture({ status: "completed", active: false });
  let calls = 0;
  const store = await storeWith(t, { listJobs: () => ++calls === 1 ? oldPoll.promise : Promise.resolve({ jobs: [] }), removeJobHistory: async () => ({ removedIds: [completed.jobId], skippedIds: [] }) });
  store.jobsState.update((state) => ({ ...state, jobs: [completed] }));
  const stale = store.loadJobs(true);
  assert.equal(await store.removeHistory([completed.jobId]), true);
  oldPoll.resolve({ jobs: [completed] });
  await stale;
  assert.deepEqual(get(store.jobsState).jobs, []);
});

test("failed history deletion preserves the entry and shows the error", async (t) => {
  const completed = fixture({ status: "completed", active: false });
  const store = await storeWith(t, { removeJobHistory: async () => { throw new Error("기록을 삭제하지 못했습니다."); } });
  store.jobsState.update((state) => ({ ...state, jobs: [completed] }));
  assert.equal(await store.removeHistory([completed.jobId]), false);
  assert.equal(get(store.jobsState).jobs.length, 1);
  assert.match(get(store.jobsState).error, /삭제하지 못/);
  assert.deepEqual(get(store.jobsState).busy, {});
});
