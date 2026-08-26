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
  assert.match(source, /focus_existing_manager/);
  assert.match(source, /SetForegroundWindow/);
  assert.match(source, /request\.show_ui\.unwrap_or\(true\)/);
  assert.match(source, /persist_job_state\(&mut opened\.state\)/);
});

test("Companion owns persistent recovery and cancellation outside the extension UI", async () => {
  const [client, background, manifest] = await Promise.all([
    read("./companion-client.js"),
    read("./background.js"),
    read("./manifest.json").then(JSON.parse),
  ]);
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.match(client, /list-jobs/);
  assert.match(client, /cancel-job/);
  assert.match(client, /MEDIA_DOWNLOAD_CAPABILITY = "media-download-v1"/);
  assert.match(client, /startCompanionMediaDownload/);
  assert.doesNotMatch(background, /restoreActiveCompanionJobs|watchCompanionJob|cancelCompanionJob/);
  assert.doesNotMatch(background, /list-download-jobs|cancel-download-job|retry-download-job/);
  assert.doesNotMatch(background, /chrome\.downloads|download-worker|native-file-writer/);
  assert.doesNotMatch(background, /start-subtitle-generation/);
  assert.doesNotMatch(background, /create-playback-session/);
  assert.doesNotMatch(background, /playback-session\.js|createPlaybackSession|resolvePlaybackSession/);
});

test("candidate and link downloads hand off to Companion without a local execution fallback", async () => {
  const background = await read("./background.js");
  const queueStart = background.indexOf("async function queueMediaDownload(candidate)");
  const queueEnd = background.indexOf("async function beginCandidateDownload", queueStart);
  const queueSource = background.slice(queueStart, queueEnd);
  assert.ok(queueStart >= 0 && queueEnd > queueStart);
  assert.match(queueSource, /resolvePlayerCandidate\(candidate\)/);
  assert.match(queueSource, /startCompanionMediaDownload\(\{/);
  assert.match(queueSource, /mode: "media-companion"/);
  assert.doesNotMatch(queueSource, /ensureDownloadWorker|run-download-job|chrome\.downloads|native-file-writer/);
  assert.doesNotMatch(background, /function dispatchMediaDownload|function recoverInterruptedMediaDownloads/);

  const candidateRoute = background.slice(
    background.indexOf('message?.type === "download-candidate"'),
    background.indexOf('message?.type === "refresh-download-candidate"'),
  );
  const linkRoute = background.slice(
    background.indexOf('message?.type === "download-url"'),
    background.indexOf('message?.type === "clear-tab"'),
  );
  assert.match(candidateRoute, /beginCandidateDownload\(candidate\)/);
  assert.match(linkRoute, /playerGraphResolver\.resolve\(targetUrl\)/);
  assert.match(linkRoute, /beginCandidateDownload\(candidate\)/);
  assert.match(background, /message\?\.type === "companion-status"/);
  assert.match(background, /message\?\.type === "show-companion-ui"/);
  assert.match(background, /function isExtensionUiSender\(sender\)/);
  assert.match(background, /sender\.url\.startsWith\(extensionRoot\)/);
  assert.doesNotMatch(background, /publicCompanionJobs|list-download-jobs/);
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
  assert.match(installer, /Naver\\Naver Whale\\NativeMessagingHosts/);
  assert.match(installer, /Microsoft\\Edge\\NativeMessagingHosts/);
  assert.match(manualInstaller, /Naver\\Naver Whale\\NativeMessagingHosts/);
  assert.match(installer, /AllowedOriginsJson/);
  assert.match(installer, /AllowedExtensionIds/);
  assert.match(installer, /AddAllowedOrigin/);
  assert.match(installer, /DefaultDirName=\{localappdata\}\\Aura Media\\Companion/);
  assert.match(installer, /UsePreviousAppDir=no/);
  assert.match(installer, /SaveStringsToUTF8FileWithoutBOM\(ManifestPath, ManifestLines, False\)/);
});

test("live media monitoring checks detection and optional Companion readiness without browser playback", async () => {
  const monitor = await read("./scripts/live-media-smoke.mjs");
  assert.match(monitor, /--require-companion/);
  assert.match(monitor, /media-download-v1/);
  assert.match(monitor, /extensionManifest\.name/);
  assert.match(monitor, /AURA_MONITOR_EXTENSION_ROOT/);
  assert.doesNotMatch(monitor, /name: "Aura Media Downloader"/);
  assert.doesNotMatch(monitor, /await verifyCandidatePlayback\(/);
  assert.doesNotMatch(monitor, /await completedChromeDownloadBytes\(/);
});

test("companion installer rejects yt-dlp releases that predate the YouTube client fix", async () => {
  const script = await read("./scripts/build-companion-installer.ps1");
  assert.match(script, /\$MinimumYtDlpVersion = \[version\]'2026\.8\.19'/);
  assert.match(script, /& \$ytDlpPath --version/);
  assert.match(script, /\$ytDlpVersion -lt \$MinimumYtDlpVersion/);
  assert.match(script, /Bundled yt-dlp .* is too old/);
});
