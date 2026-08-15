import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

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

test("download progress renders under its detected video card with accessible status", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /id="download-summary"/);
  assert.doesNotMatch(html, /id="download-jobs"/);
  assert.match(html, /id="detect-jobs"/);
  assert.match(html, /id="link-jobs"/);
  assert.match(script, /candidate-job-list/);
  assert.match(script, /job\.candidateId === container\.dataset\.candidateId/);
  assert.match(script, /buildJobCard\(job, \{ inline: true \}\)/);
  assert.match(script, /buildJobCard\(job\)/);
  assert.match(script, /container\.hidden = collapsed \|\| surfaceJobs\.length === 0/);
  assert.match(script, /downloadJobView\(job, t\)/);
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
  assert.match(css, /\.job-retry-button,\s*\.job-cancel-button\s*\{[^}]*min-height:\s*30px/s);
  assert.doesNotMatch(script, /className = "job-actions"/);
  assert.match(css, /\.job-status-row\s*\{/);
  assert.match(css, /\.job-retry-button:focus-visible/);
});

test("both tabs expose collapsible flushable lists and active-job cancellation", async () => {
  const [html, script, css] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
  ]);
  for (const surface of ["detect", "link"]) {
    assert.match(html, new RegExp(`id="${surface}-jobs-toggle"`));
    assert.match(html, new RegExp(`id="${surface}-jobs-clear"`));
  }
  assert.match(script, /type:\s*"cancel-download-job",\s*jobId:\s*job\.id/);
  assert.doesNotMatch(script, /start-mse-capture|job-capture-button|재생 캡처/);
  assert.match(script, /type:\s*"clear-download-jobs",\s*surface/);
  assert.match(script, /collapsedJobSurfaces/);
  assert.doesNotMatch(html, /id="mobile-mode"/);
  assert.doesNotMatch(script, /type:\s*"mobile-ua-toggle"/);
  assert.doesNotMatch(script, /type:\s*"mobile-ua-status"/);
  assert.match(css, /\.candidate-list\.jobs-collapsed \.candidate-job-list/);
  assert.match(css, /\.job-cancel-button/);
  assert.doesNotMatch(css, /\.job-capture-button/);
});

test("candidate downloads queue without subtitle translation work", async () => {
  const script = await readFile(new URL("./popup.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /prepareSubtitleTranslationModels|subtitle-translation|자막 준비/);
  assert.match(script, /type:\s*"download-candidate"/);
  assert.doesNotMatch(script, /translatedTitle|translateTitleToKorean/);
});

test("popover sizes to its content and keeps one document scroller", async () => {
  const css = await readFile(new URL("./popup.css", import.meta.url), "utf8");
  const html = await readFile(new URL("./popup.html", import.meta.url), "utf8");
  const script = await readFile(new URL("./popup.js", import.meta.url), "utf8");
  assert.doesNotMatch(css, /height:\s*600px|min-height:\s*600px/);
  assert.doesNotMatch(css, /\.popup-shell\s*\{[^}]*height:\s*100%/s);
  assert.match(css, /html\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0/s);
  assert.match(css, /html\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*scroll/s);
  assert.match(css, /\.popup-shell\s*\{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.tab-panel\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.tab-panel\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.doesNotMatch(css, /\.popup-shell\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(script, /addEventListener\(\s*["']wheel["']/);
  assert.doesNotMatch(script, /preventDefault\(\).*wheel|wheel.*preventDefault\(\)/s);
  assert.doesNotMatch(html, /id="scroll-more"/);
  assert.doesNotMatch(html, /scroll-more/);
});

test("link tab exposes YouTube quality caps and sends the selection", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="youtube-quality"/);
  for (const quality of ["1080", "720", "480"]) {
    assert.match(html, new RegExp(`value="${quality}"`));
  }
  assert.match(script, /\["best", \.\.\.numeric\]/);
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
  assert.match(script, /currentPlan\.id === "pro" \? \["best", \.\.\.numeric\] : numeric/);
  assert.match(script, /normalizedDetectedQualities/);
  assert.doesNotMatch(html, /value="best"/);
  assert.match(script, /\^https:\\\/\\\//);
});

test("link panel is compact by default and expands only when activity appears", async () => {
  const browser = await launchPopupLayoutBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
    await page.goto(new URL("./popup.html", import.meta.url).href, { waitUntil: "domcontentloaded" });
    const layout = await page.evaluate(() => {
      document.querySelector("script[type='module']")?.remove();
      document.getElementById("panel-detect").hidden = true;
      const panel = document.getElementById("panel-link");
      panel.hidden = false;
      const button = document.getElementById("download-url");
      const compact = {
        height: panel.getBoundingClientRect().height,
        trailingGap: panel.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom,
      };
      const status = document.getElementById("direct-status");
      status.hidden = false;
      status.textContent = "다운로드를 시작했습니다.";
      const tools = document.getElementById("link-jobs-tools");
      tools.hidden = false;
      const jobs = document.getElementById("link-jobs");
      jobs.hidden = false;
      const card = document.createElement("article");
      card.className = "job-card";
      card.textContent = "다운로드 중 42%";
      jobs.append(card);
      const save = document.getElementById("link-save-status");
      save.hidden = false;
      save.textContent = "저장 준비됨";
      return {
        compact,
        expandedHeight: panel.getBoundingClientRect().height,
      };
    });
    assert.ok(layout.compact.trailingGap <= 1, `default trailing gap: ${layout.compact.trailingGap}`);
    assert.ok(layout.expandedHeight > layout.compact.height + 60);
  } finally {
    await browser.close();
  }
});

test("popup verifies the folder but delegates downloads to the persistent worker", async () => {
  const [script, background, worker] = await Promise.all([
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./background.js", import.meta.url), "utf8"),
    readFile(new URL("./download-worker.js", import.meta.url), "utf8"),
  ]);
  assert.match(script, /verifySaveFolderWritable/);
  assert.doesNotMatch(script, /runCandidateInPopup|runYouTubeReceptionInPopup|popup-closed|runInPopup/);
  assert.doesNotMatch(background, /runInPopup|mode:\s*"popup"/);
  assert.match(background, /type:\s*"parallel-save"/);
  assert.doesNotMatch(background, /type:\s*"parallel-save"[\s\S]{0,180}dirHandle/);
  assert.match(worker, /getStoredSaveDirectory\(\)/);
  assert.match(worker, /createUniqueFile\(directoryHandle, filename\)/);
  assert.match(worker, /cancelledJobIds\.has\(message\.jobId\)/);
  assert.doesNotMatch(worker, /message\.dirHandle/);
});

test("every direct filesystem save allocates a non-overwriting filename", async () => {
  const [hls, saveDirectory] = await Promise.all([
    readFile(new URL("./hls-download.js", import.meta.url), "utf8"),
    readFile(new URL("./save-directory.js", import.meta.url), "utf8"),
  ]);
  assert.match(hls, /createUniqueFile\(saveHandle, filename\)/);
  assert.doesNotMatch(hls, /saveHandle\.getFileHandle\(filename, \{ create: true \}\)/);
  assert.match(saveDirectory, /numberedFilename/);
});

test("popup and settings render every visible string through the locale table", async () => {
  const [popupHtml, popupScript, optionsHtml, optionsScript] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./options.html", import.meta.url), "utf8"),
    readFile(new URL("./options.js", import.meta.url), "utf8"),
  ]);
  const korean = /[\uAC00-\uD7A3]/;
  assert.doesNotMatch(popupHtml, korean, "popup.html must not hardcode Korean copy");
  assert.doesNotMatch(optionsHtml, korean, "options.html must not hardcode Korean copy");
  for (const [name, script] of [["popup.js", popupScript], ["options.js", optionsScript]]) {
    for (const line of script.split("\n")) {
      if (!korean.test(line)) continue;
      assert.match(line.trim(), /^\/\//, `${name} keeps Korean only in comments: ${line.trim()}`);
    }
  }
  assert.match(popupScript, /applyLocale\(await loadLocale\(\)\)/);
  assert.match(popupScript, /changes\[LOCALE_STORAGE_KEY\]/);
  assert.match(optionsScript, /changes\[LOCALE_STORAGE_KEY\]/);
});

test("language lives in a header globe menu, not inside settings", async () => {
  const [popupHtml, popupScript, popupCss, optionsHtml] = await Promise.all([
    readFile(new URL("./popup.html", import.meta.url), "utf8"),
    readFile(new URL("./popup.js", import.meta.url), "utf8"),
    readFile(new URL("./popup.css", import.meta.url), "utf8"),
    readFile(new URL("./options.html", import.meta.url), "utf8"),
  ]);
  assert.match(popupHtml, /id="locale"[^>]*aria-haspopup="true"/);
  assert.match(popupHtml, /id="locale-menu"[^>]*role="menu"/);
  assert.match(popupScript, /renderLocaleMenu/);
  assert.match(popupScript, /saveLocale\(locale\)/);
  assert.match(popupScript, /closeLocaleMenu/);
  assert.match(popupCss, /\.locale-menu\s*\{/);
  assert.doesNotMatch(optionsHtml, /id="ui-locale"/);
  assert.doesNotMatch(optionsHtml, /settings\.language/);
});

test("settings keeps the Pro purchase flow collapsed behind one action", async () => {
  const [optionsHtml, optionsScript] = await Promise.all([
    readFile(new URL("./options.html", import.meta.url), "utf8"),
    readFile(new URL("./options.js", import.meta.url), "utf8"),
  ]);
  assert.match(optionsHtml, /id="purchase-toggle"[^>]*aria-expanded="false"/);
  assert.match(optionsHtml, /id="purchase-panel" hidden/);
  assert.match(optionsScript, /purchasePanel\.hidden = !opening/);
  // Three sections at most: license (with purchase inside) and the save folder.
  assert.equal((optionsHtml.match(/<section/g) || []).length, 2);
});

test("the in-page download overlay follows the stored UI locale", async () => {
  const content = await readFile(new URL("./content.js", import.meta.url), "utf8");
  assert.match(content, /OVERLAY_LOCALE_KEY = "auraUiLocale"/);
  for (const locale of ["ko", "en", "ja", "zh"]) {
    assert.match(content, new RegExp(`\\b${locale}:\\s*\\{`), `overlay is missing ${locale}`);
  }
  assert.match(content, /overlayText\("heading"\)/);
  assert.match(content, /syncOverlayLocale/);
  // Progress is still parsed from the canonical Korean pipeline text.
  assert.match(content, /저장 중…/);
});

async function launchPopupLayoutBrowser() {
  const launchers = [
    () => chromium.launch({ channel: "chrome", headless: true }),
    () => chromium.launch({ channel: "msedge", headless: true }),
    () => chromium.launch({
      headless: true,
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    }),
  ];
  let lastError = null;
  for (const launch of launchers) {
    try {
      return await launch();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("no-browser-for-popup-layout");
}

test("long popup content stays vertically reachable on the document scroller", async () => {
  const browser = await launchPopupLayoutBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await page.goto(new URL("./popup.html", import.meta.url).href, {
      waitUntil: "domcontentloaded",
    });
    await page.addStyleTag({
      content: ".probe-block{height:180px;margin:8px 0;background:#243754}",
    });
    await page.evaluate(() => {
      document.querySelector("script[type='module']")?.remove();
      const list = document.getElementById("candidates");
      list.replaceChildren();
      for (let index = 1; index <= 8; index += 1) {
        const card = document.createElement("article");
        card.className = "candidate-card probe-block";
        card.id = `probe-card-${index}`;
        card.textContent = `probe card ${index}`;
        list.append(card);
      }
    });
    const layout = await page.evaluate(() => {
      const inspect = (el) => {
        const style = getComputedStyle(el);
        return {
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          canScroll: el.scrollHeight - el.clientHeight > 1,
        };
      };
      const html = inspect(document.documentElement);
      const panel = inspect(document.getElementById("panel-detect"));
      const last = document.getElementById("probe-card-8");
      last.scrollIntoView();
      const lastBox = last.getBoundingClientRect();
      return {
        html,
        body: inspect(document.body),
        shell: inspect(document.querySelector(".popup-shell")),
        panel,
        candidates: inspect(document.getElementById("candidates")),
        lastVisible: lastBox.bottom > 0 && lastBox.top < window.innerHeight,
        scrollY: window.scrollY,
      };
    });
    assert.equal(layout.html.overflowY, "scroll");
    assert.equal(layout.html.canScroll, true);
    assert.equal(layout.panel.overflowY, "visible");
    assert.equal(layout.panel.canScroll, false);
    assert.equal(layout.shell.overflowY, "visible");
    assert.equal(layout.candidates.overflowY, "visible");
    assert.equal(layout.lastVisible, true);
    assert.ok(layout.scrollY > 0);
  } finally {
    await browser.close();
  }
});
