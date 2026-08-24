import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("companion jobs are detached from the native bridge", async () => {
  const source = await read("./native-host/src/main.rs");
  // A submitted job runs in its own process so the transfer survives the
  // browser closing the native messaging port.
  assert.match(source, /spawn_detached\(&\["--run-job", &request_path_text\]\)/);
  assert.match(source, /Some\("--run-job"\)/);
  assert.match(source, /execute_download\(request, \|_\| \{\}\)/);
  assert.match(source, /read_job_state/);
});

test("the per-job Win32 progress window is gone and the manager binary owns the UI", async () => {
  const source = await read("./native-host/src/main.rs");
  // Progress used to open a throwaway Win32 window per job. The manager window
  // in `companion-gui` replaced it, so the host must carry no window code and
  // must not spawn a per-job UI process.
  assert.doesNotMatch(source, /--job-ui/);
  assert.doesNotMatch(source, /mod windows_ui/);
  assert.doesNotMatch(source, /run_job_ui/);
  assert.doesNotMatch(source, /CreateWindowExW/);

  // `--manager` stays so an old Start Menu shortcut still opens the window, and
  // it must resolve the separate binary rather than re-running the host.
  assert.match(source, /Some\("--manager"\)/);
  assert.match(source, /MANAGER_EXECUTABLE: &str = "aura-media-manager\.exe"/);
  assert.match(source, /manager-not-installed/);
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
  assert.match(background, /ACTIVE_COMPANION_STATUSES = new Set\(\["created", "preparing", "submitting", "queued", "running"\]\)/);
  assert.match(background, /remote\.jobType === "subtitle"/);
  assert.match(background, /source: subtitleJob \? "companion" : "youtube"/);
});

test("companion installers include the store and current development extension origins", async () => {
  const [script, manualInstaller, installer, originConfig] = await Promise.all([
    read("./scripts/build-companion-installer.ps1"),
    read("./install-media-companion.ps1"),
    read("./installer/AuraMediaCompanion.iss"),
    read("./installer/companion-extension-origins.json").then(JSON.parse),
  ]);
  assert.equal(originConfig.chromeStoreExtensionId, "kniniopdkceodiddkijnddnggdgmjmmo");
  assert.ok(originConfig.developmentExtensionIds.includes("fnnilboncpjgaachejfhednccmfflmkl"));
  for (const source of [script, manualInstaller]) {
    assert.match(source, /companion-extension-origins\.json/);
    assert.match(source, /developmentExtensionIds/);
  }
  assert.match(script, /AllowedExtensionIds/);
  assert.match(script, /Select-Object -Unique/);
  assert.match(script, /Inno Setup 7/);
  assert.match(installer, /Google\\Chrome\\NativeMessagingHosts/);
  assert.match(installer, /Microsoft\\Edge\\NativeMessagingHosts/);
  assert.match(installer, /AllowedOriginsJson/);
  assert.match(installer, /AllowedExtensionIds/);
  assert.match(installer, /AddAllowedOrigin/);
  assert.match(installer, /DefaultDirName=\{localappdata\}\\Aura Media\\Companion/);
  assert.match(installer, /UsePreviousAppDir=no/);
  assert.match(installer, /SaveStringsToUTF8FileWithoutBOM\(ManifestPath, ManifestLines, False\)/);
});
