import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("popover exposes detection, downloads, and YouTube without development test mode", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  for (const tab of ["detect", "downloads", "youtube"]) {
    assert.match(html, new RegExp(`data-tab="${tab}"`));
    assert.match(html, new RegExp(`id="panel-${tab}"`));
  }
  assert.doesNotMatch(html, /개발 테스트 모드|test-domains|test-mode/);
  assert.doesNotMatch(html, /choose-folder|폴더 선택/);
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

test("downloads tab renders truthful accessible job progress", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /id="download-summary"/);
  assert.match(script, /downloadJobView\(job\)/);
  assert.doesNotMatch(script, /job-marker/);
  assert.match(script, /role", "progressbar"/);
  assert.match(script, /aria-valuenow/);
  assert.match(css, /job-progress\.indeterminate/);
  assert.match(css, /prefers-reduced-motion/);
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

test("YouTube tab exposes supported quality caps and sends the selection", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="youtube-quality"/);
  for (const quality of ["best", "2160", "1440", "1080", "720", "480"]) {
    assert.match(html, new RegExp(`value="${quality}"`));
  }
  assert.match(script, /quality:\s*byId\("youtube-quality"\)\.value/);
});
