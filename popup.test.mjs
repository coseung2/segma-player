import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("popover exposes detection and link input without development test mode", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  for (const tab of ["detect", "link"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(html, new RegExp(`id="panel-${tab}"`));
  }
  assert.doesNotMatch(html, /data-tab="downloads"/);
  assert.doesNotMatch(html, /id="panel-downloads"/);
  assert.doesNotMatch(html, /개발 테스트 모드|test-domains|test-mode/);
  assert.doesNotMatch(html, /choose-folder|폴더 선택/);
  assert.doesNotMatch(html, /tab-youtube|panel-youtube|youtube-mark|youtube-url|youtube-download/);
  assert.doesNotMatch(script, /auraTestMode|auraTestDomains/);
  assert.doesNotMatch(script, /showDirectoryPicker|folder-store/);
  assert.match(script, /candidate-preview/);
});

test("normal media downloads use the offscreen worker instead of opening a tab", async () => {
  const [manifestText, background] = await Promise.all([
    readFile(new URL("./manifest.json", import.meta.url), "utf8"),
    readFile(new URL("./background.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.permissions.includes("offscreen"), true);
  assert.equal(manifest.content_scripts.some((entry) => entry.world === "MAIN"
    && entry.js?.includes("level5-page-bridge.js") && entry.all_frames === true), true);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.doesNotMatch(background, /chrome\.tabs\.create/);
});

test("inline job lists render truthful accessible progress without a downloads tab", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /id="download-summary"/);
  assert.doesNotMatch(html, /id="download-jobs"/);
  assert.match(html, /id="detect-jobs"/);
  assert.match(html, /id="link-jobs"/);
  assert.match(script, /buildJobCard\(job\)/);
  assert.match(script, /container\.hidden = jobs\.length === 0/);
  assert.match(script, /downloadJobView\(job\)/);
  assert.doesNotMatch(script, /job-marker/);
  assert.match(script, /role", "progressbar"/);
  assert.match(script, /aria-valuenow/);
  assert.match(css, /job-progress\.indeterminate/);
  assert.match(css, /prefers-reduced-motion/);
});

test("failed retryable downloads expose an accessible retry action", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
  ]);
  assert.match(script, /retryableDownloadJob\(job\)/);
  assert.match(script, /type:\s*"retry-download-job",\s*jobId:\s*job\.id/);
  assert.match(script, /retry\.disabled = true/);
  assert.match(script, /aria-live", "polite"/);
  assert.match(css, /\.job-retry-button\s*\{[^}]*min-height:\s*30px/s);
  assert.match(css, /\.job-status-row\s*\{/);
  assert.match(css, /\.job-retry-button:focus-visible/);
});

test("candidate downloads queue without subtitle translation work", async () => {
  const script = await readFile(new URL("./popup.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /prepareSubtitleTranslationModels|subtitle-translation|자막 준비/);
  assert.match(script, /type:\s*"download-candidate"/);
  assert.doesNotMatch(script, /translatedTitle|translateTitleToKorean/);
});

test("popover hides its single scrollbar and exposes a more-content control", async () => {
  const css = await readFile(new URL("./popup.css", import.meta.url), "utf8");
  const html = await readFile(new URL("./popup.html", import.meta.url), "utf8");
  assert.match(css, /\.popup-shell\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /html\s*\{[^}]*height:\s*600px[^}]*min-height:\s*600px/s);
  assert.doesNotMatch(css, /max-height:\s*100vh/);
  assert.match(css, /\.popup-shell\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /\.tab-panel\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /\.popup-shell::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
  assert.match(html, /id="scroll-more"/);
  assert.match(html, /m7 6 5 5 5-5/);
});

test("link tab exposes YouTube quality caps and sends the selection", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="youtube-quality"/);
  for (const quality of ["best", "2160", "1440", "1080", "720", "480"]) {
    assert.match(html, new RegExp(`value="${quality}"`));
  }
  assert.match(script, /type:\s*"youtube-download"/);
  assert.match(script, /quality:\s*byId\("youtube-quality"\)\.value/);
  assert.match(script, /updateLinkPanel/);
});

test("free plan UI gates paid work while keeping Pro benefits visible", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="plan-summary"/);
  assert.match(html, /id="pro-benefits"/);
  assert.match(html, /id="license-entry"/);
  assert.doesNotMatch(script, /koreanSubtitleTrack|한국어 자막/);
  assert.match(script, /option\.disabled = !youtubeQualityAllowed/);
  assert.match(script, /\^https:\\\/\\\//);
});
