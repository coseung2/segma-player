import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createMediaRequestDiagnosticStore,
  resolveMediaRequestContext,
} from "./media-request-context.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const redactedDiagnosticsContract = JSON.parse(await read(
  "./test-fixtures/companion/redacted-diagnostics-v1.json",
));

test("shared diagnostics fixture passes through the shipped redaction behavior", () => {
  const { input, expected, forbiddenFragments } = redactedDiagnosticsContract;
  let now = input.startedAt;
  const resolved = resolveMediaRequestContext({
    url: input.url,
    fallbackReferrer: input.fallbackReferrer,
    sourceContext: input.sourceContext,
    consumer: input.consumer,
    lookupRequestHeaders: () => input.lookup,
  });
  const store = createMediaRequestDiagnosticStore({ now: () => now });
  assert.equal(store.start({
    leaseId: input.leaseId,
    requestTabId: input.requestTabId,
    url: resolved.url,
    diagnostic: resolved.diagnostic,
  }), true);
  now = input.completedAt;
  const completed = store.finish({
    tabId: input.requestTabId,
    url: input.url,
    statusCode: input.statusCode,
    resourceType: input.resourceType,
  });

  assert.deepEqual(completed, expected);
  const serialized = JSON.stringify(completed);
  for (const fragment of forbiddenFragments) assert.doesNotMatch(serialized, new RegExp(fragment));
});

test("the per-job Win32 progress window is gone and the manager binary owns the UI", async () => {
  const [source, legacyWriter, process, nativeModules] = await Promise.all([
    read("./native-host/src/main.rs"),
    read("./native-host/src/legacy_writer.rs"),
    read("./native-host/src/process.rs"),
    Promise.all([
      "main.rs",
      "process.rs",
      "protocol.rs",
      "job_store.rs",
    ].map((file) => read(`./native-host/src/${file}`))).then((parts) => parts.join("\n")),
  ]);
  // Progress used to open a throwaway Win32 window per job. The manager window
  // in `companion-gui` replaced it, so the host must carry no window code and
  // must not spawn a per-job UI process.
  assert.doesNotMatch(nativeModules, /--job-ui/);
  assert.doesNotMatch(nativeModules, /mod windows_ui/);
  assert.doesNotMatch(nativeModules, /run_job_ui/);
  assert.doesNotMatch(nativeModules, /CreateWindowExW/);

  // `--manager` stays so an old Start Menu shortcut still opens the window, and
  // it must resolve the separate binary rather than re-running the host.
  assert.match(source, /Some\("--manager"\)/);
  assert.match(process, /MANAGER_EXECUTABLE: &str = "aura-media-manager\.exe"/);
  assert.match(process, /manager-not-installed/);
  assert.match(source, /focus_existing_manager/);
  assert.match(source, /SetForegroundWindow/);
  assert.match(legacyWriter, /request\.show_ui\.unwrap_or\(true\)/);
  assert.match(legacyWriter, /persist_job_state\(&mut opened\.state\)/);
});

test("native execution lifecycles stay outside the composition root", async () => {
  const [source, legacyWriter, youtube] = await Promise.all([
    read("./native-host/src/main.rs"),
    read("./native-host/src/legacy_writer.rs"),
    read("./native-host/src/youtube.rs"),
  ]);

  assert.doesNotMatch(source, /struct MediaWriter/);
  assert.doesNotMatch(source, /fn handle_media_request/);
  assert.doesNotMatch(source, /fn execute_youtube_download/);
  assert.doesNotMatch(source, /Command::new\(&yt_dlp\)/);
  assert.doesNotMatch(source, /RecvTimeoutError/);

  assert.match(legacyWriter, /pub fn handle_request/);
  assert.match(legacyWriter, /pub fn disconnect/);
  for (const command of ["media-open", "media-chunk", "media-close", "media-abort", "media-suspend"]) {
    assert.match(legacyWriter, new RegExp(`"${command}"`));
  }
  assert.match(youtube, /pub fn execute/);
  assert.match(youtube, /Command::new\(&yt_dlp\)/);
  assert.match(youtube, /RecvTimeoutError/);
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

test("the extension stays free while the installed app owns General and Pro", async () => {
  const [background, manager, license, nativeHost, runtimeFiles] = await Promise.all([
    read("./background.js"),
    read("./companion-gui/src/app.rs"),
    read("./companion-gui/src/license.rs"),
    read("./native-host/src/main.rs"),
    import("./scripts/build-dev-staging.mjs").then((module) => module.STORE_RUNTIME_FILES),
  ]);
  assert.doesNotMatch(background, /auraLicense|activateLicense|resolveEdition|resolvePlan/);
  assert.equal(runtimeFiles.includes("license.js"), false);
  assert.match(manager, /AI 자막 생성은 앱 Pro 기능입니다/);
  assert.match(manager, /self\.view = View::Settings/);
  assert.match(license, /LICENSE_API_URL/);
  assert.match(license, /licenseKey/);
  assert.match(nativeHost, /"entitlementOwner": "companion"/);
  assert.match(nativeHost, /license_edition\.as_deref\(\) == Some\("pro"\)/);
});

test("candidate and link downloads have no local execution fallback", async () => {
  const [background, content, handoff] = await Promise.all([
    read("./background.js"),
    read("./content.js"),
    read("./background-companion-handoff.js"),
  ]);
  assert.match(background, /createCompanionHandoff\(\{ resolveCandidate: resolvePlayerCandidate \}\)/);
  assert.match(handoff, /const transferCandidate = await resolveCandidate\(candidate\)/);
  assert.match(handoff, /startMedia\(\{/);
  assert.match(handoff, /mode: "media-companion"/);
  assert.doesNotMatch(handoff, /ensureDownloadWorker|run-download-job|chrome\.downloads|native-file-writer/);
  assert.doesNotMatch(content, /download-direct|anchor\.download|referrerPolicy = "unsafe-url"/);
  assert.doesNotMatch(content, /show-download-overlay|hide-download-overlay|list-download-jobs|cancel-download-job/);
  assert.doesNotMatch(`${background}\n${handoff}`, /function dispatchMediaDownload|function recoverInterruptedMediaDownloads/);

  assert.match(background, /downloadRouter\.downloadCandidate\(message\.candidateId\)/);
  assert.match(background, /downloadRouter\.downloadUrl\(message\.url\)/);
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
