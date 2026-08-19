import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("companion jobs are detached from both the native bridge and progress window", async () => {
  const source = await read("./native-host/src/main.rs");
  assert.match(source, /spawn_detached\(&\["--run-job", &request_path_text\]\)/);
  assert.match(source, /spawn_detached\(&\["--job-ui", &request\.job_id\]\)/);
  assert.match(source, /Some\("--run-job"\)/);
  assert.match(source, /execute_download\(request, \|_\| \{\}\)/);
  assert.match(source, /Some\("--job-ui"\)/);
  assert.match(source, /read_job_state/);
  assert.doesNotMatch(source, /run_job_ui\(move \|notify\| execute_download/);
});

test("companion exposes persistent job recovery and cancellation to the extension", async () => {
  const [client, background, manifest] = await Promise.all([
    read("./companion-client.js"),
    read("./background.js"),
    read("./manifest.json").then(JSON.parse),
  ]);
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.match(client, /list-jobs/);
  assert.match(client, /cancel-job/);
  assert.match(background, /restoreActiveCompanionJobs/);
  assert.match(background, /watchCompanionJob/);
  assert.match(background, /cancelCompanionJob/);
});

test("companion installers register both Chrome and Edge origins when supplied", async () => {
  const [script, installer] = await Promise.all([
    read("./scripts/build-companion-installer.ps1"),
    read("./installer/AuraMediaCompanion.iss"),
  ]);
  assert.match(script, /ChromeExtensionId/);
  assert.match(script, /EdgeExtensionId/);
  assert.match(installer, /Google\\Chrome\\NativeMessagingHosts/);
  assert.match(installer, /Microsoft\\Edge\\NativeMessagingHosts/);
  assert.match(installer, /AllowedOriginsJson/);
});
