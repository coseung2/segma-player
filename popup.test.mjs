import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  // Browser layout coverage is optional in lightweight Node-only environments.
}

const OWNED = {
  popupHtml: new URL("./popup.html", import.meta.url),
  popupJs: new URL("./popup.js", import.meta.url),
  popupCss: new URL("./popup.css", import.meta.url),
  optionsHtml: new URL("./compatibility/extension-primary/options.html", import.meta.url),
  optionsJs: new URL("./compatibility/extension-primary/options.js", import.meta.url),
};

async function readOwned() {
  const [popupHtml, popupJs, popupCss, optionsHtml, optionsJs] = await Promise.all([
    readFile(OWNED.popupHtml, "utf8"),
    readFile(OWNED.popupJs, "utf8"),
    readFile(OWNED.popupCss, "utf8"),
    readFile(OWNED.optionsHtml, "utf8"),
    readFile(OWNED.optionsJs, "utf8"),
  ]);
  return { popupHtml, popupJs, popupCss, optionsHtml, optionsJs };
}

function assertNoOwnedSurface(source, label) {
  assert.doesNotMatch(source, /settings-overlay|settings-frame|iframe/i, `${label} must not embed settings`);
  assert.doesNotMatch(source, /plan-badge|pro-offer|license-entry|upgrade-link|purchase-|license-activate/i, `${label} must not own license or purchase`);
  assert.doesNotMatch(source, /parallel-folder|save-directory|showDirectoryPicker|folder-store/i, `${label} must not own the save folder`);
  assert.doesNotMatch(source, /candidate-preview|<video|playback-addon|subtitle-settings|subtitle-folder/i, `${label} must not own playback or subtitles`);
  assert.doesNotMatch(source, /detect-jobs|link-jobs|job-list|retry-download-job|cancel-download-job|clear-download-jobs|list-download-jobs/i, `${label} must not own jobs`);
}

test("popover exposes detection and link input without development test mode", async () => {
  const { popupHtml, popupJs } = await readOwned();
  for (const tab of ["detect", "link"]) {
    assert.match(popupHtml, new RegExp(`data-tab="${tab}"`));
    assert.match(popupHtml, new RegExp(`id="panel-${tab}"`));
  }
  assert.doesNotMatch(popupHtml, /data-tab="downloads"/);
  assert.doesNotMatch(popupHtml, /id="panel-downloads"/);
  assert.doesNotMatch(popupHtml, /개발 테스트 모드|test-domains|test-mode/);
  assert.doesNotMatch(popupHtml, /choose-folder|폴더 선택/);
  assert.doesNotMatch(popupHtml, /tab-youtube|panel-youtube|youtube-mark|youtube-url/);
  assert.doesNotMatch(popupJs, /auraTestMode|auraTestDomains/);
  assert.doesNotMatch(popupJs, /showDirectoryPicker|folder-store/);
});

test("popup stays a thin Segma Player connector", async () => {
  const { popupHtml, popupJs, popupCss, optionsHtml, optionsJs } = await readOwned();
  for (const [label, source] of [
    ["popup.html", popupHtml],
    ["popup.js", popupJs],
    ["popup.css", popupCss],
    ["options.html", optionsHtml],
    ["options.js", optionsJs],
  ]) assertNoOwnedSurface(source, label);

  assert.match(popupHtml, /id="candidates"/);
  assert.match(popupHtml, /id="download-url"/);
  assert.match(popupHtml, /id="companion-status"/);
  assert.match(popupHtml, /id="companion-help"[^>]*hidden/);
  assert.match(popupHtml, /id="companion-open"/);
  assert.match(popupJs, /type:\s*"list-candidates"/);
  assert.match(popupJs, /type:\s*"download-candidate"/);
  assert.match(popupJs, /type:\s*"download-url"/);
  assert.match(popupJs, /type:\s*"youtube-download"/);
  assert.match(popupJs, /type:\s*"companion-status"/);
  assert.match(popupJs, /type:\s*"show-companion-ui"/);
  assert.doesNotMatch(popupJs, /from "\.\/companion-client\.js"/);
  assert.doesNotMatch(popupJs, /from "\.\/save-directory\.js"/);
  assert.doesNotMatch(popupJs, /from "\.\/download-job-view\.js"/);
  assert.doesNotMatch(popupJs, /from "\.\/product-plan\.js"/);
  assert.doesNotMatch(optionsJs, /from "\.\/companion-client\.js"/);
  assert.doesNotMatch(optionsJs, /from "\.\/save-directory\.js"/);
  assert.doesNotMatch(optionsJs, /from "\.\/license\.js"/);
  assert.doesNotMatch(optionsHtml, /id="license-section"|id="purchase-panel"|id="parallel-folder"/);
  assert.equal((optionsHtml.match(/<section/g) || []).length, 1);
});

test("candidate downloads queue without subtitle translation work", async () => {
  const { popupJs } = await readOwned();
  assert.doesNotMatch(popupJs, /prepareSubtitleTranslationModels|subtitle-translation|자막 준비/);
  assert.match(popupJs, /type:\s*"download-candidate"/);
  assert.doesNotMatch(popupJs, /translatedTitle|translateTitleToKorean/);
});

test("rescan wakes every player frame and waits for a rebuilt candidate list", async () => {
  const { popupJs } = await readOwned();
  assert.match(popupJs, /target:\s*\{\s*tabId:\s*tab\.id,\s*allFrames:\s*true\s*\}/s);
  assert.match(popupJs, /aura-media-detector-rescan-v1/);
  assert.match(popupJs, /window\.dispatchEvent\(new Event\(eventType\)\)/);
  assert.match(popupJs, /for \(const delayMs of \[200, 600, 1_200\]\)/);
  assert.doesNotMatch(popupJs, /tabs\.sendMessage\(tab\.id,\s*\{\s*type:\s*"rescan"/);
});

test("popover sizes to its content and keeps one document scroller", async () => {
  const { popupHtml, popupJs, popupCss } = await readOwned();
  assert.doesNotMatch(popupCss, /height:\s*600px|min-height:\s*600px/);
  assert.doesNotMatch(popupCss, /\.popup-shell\s*\{[^}]*height:\s*100%/s);
  assert.match(popupCss, /html\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0/s);
  assert.match(popupCss, /html\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*scroll/s);
  assert.match(popupCss, /\.popup-shell\s*\{[^}]*overflow:\s*visible/s);
  assert.match(popupCss, /\.tab-panel\s*\{[^}]*max-width:\s*100%[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(popupCss, /\.tab-panel\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.doesNotMatch(popupCss, /\.popup-shell\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(popupJs, /addEventListener\(\s*["']wheel["']/);
  assert.doesNotMatch(popupJs, /preventDefault\(\).*wheel|wheel.*preventDefault\(\)/s);
  assert.doesNotMatch(popupHtml, /id="scroll-more"/);
  assert.doesNotMatch(popupHtml, /scroll-more/);
});

test("link tab exposes YouTube quality caps and sends the selection", async () => {
  const { popupHtml, popupJs } = await readOwned();
  assert.match(popupHtml, /id="youtube-quality"/);
  for (const quality of ["best", "1080", "720", "480"]) {
    assert.match(popupHtml, new RegExp(`value="${quality}"`));
  }
  assert.match(popupJs, /type:\s*"youtube-download"/);
  assert.match(popupJs, /quality:\s*byId\("youtube-quality"\)\.value/);
  assert.match(popupJs, /updateLinkPanel/);
});

test("popup and settings render every visible string through the locale table", async () => {
  const { popupHtml, popupJs, optionsHtml, optionsJs } = await readOwned();
  const korean = /[\uAC00-\uD7A3]/;
  assert.doesNotMatch(popupHtml, korean, "popup.html must not hardcode Korean copy");
  assert.doesNotMatch(optionsHtml, korean, "options.html must not hardcode Korean copy");
  for (const [name, script] of [["popup.js", popupJs], ["options.js", optionsJs]]) {
    for (const line of script.split("\n")) {
      if (!korean.test(line)) continue;
      assert.match(line.trim(), /^\/\//, `${name} keeps Korean only in comments: ${line.trim()}`);
    }
  }
  assert.match(popupJs, /applyLocale\(await loadLocale\(\)\)/);
  assert.match(popupJs, /changes\[LOCALE_STORAGE_KEY\]/);
  assert.match(optionsJs, /changes\[LOCALE_STORAGE_KEY\]/);
});

test("Companion status covers connected, unavailable, and update states", async () => {
  const { popupHtml, popupJs, popupCss, optionsHtml, optionsJs } = await readOwned();
  assert.match(popupHtml, /id="companion-help"[^>]*data-i18n="companion\.install"[^>]*hidden/);
  assert.match(popupJs, /COMPANION_INSTALL_URL/);
  assert.match(popupJs, /companion\.connected/);
  assert.match(popupJs, /companion\.unavailable/);
  assert.match(popupJs, /companion\.update/);
  assert.match(popupJs, /\^https:\\\/\\\//);
  assert.match(popupCss, /\.companion-help\s*\{[^}]*min-height:\s*44px/);
  assert.match(popupJs, /window\.addEventListener\("focus", \(\) => void refreshCompanionStatus\(\)\)/);
  assert.match(optionsHtml, /id="companion-status"/);
  assert.match(optionsJs, /type:\s*"companion-status"/);
  assert.match(optionsJs, /type:\s*"show-companion-ui"/);
});

test("language lives in a header globe menu, not inside settings", async () => {
  const { popupHtml, popupJs, popupCss, optionsHtml } = await readOwned();
  assert.match(popupHtml, /id="locale"[^>]*aria-haspopup="true"/);
  assert.match(popupHtml, /id="locale-menu"[^>]*role="menu"/);
  assert.match(popupJs, /renderLocaleMenu/);
  assert.match(popupJs, /saveLocale\(locale\)/);
  assert.match(popupJs, /closeLocaleMenu/);
  assert.match(popupCss, /\.locale-menu\s*\{/);
  assert.doesNotMatch(optionsHtml, /id="ui-locale"/);
  assert.doesNotMatch(optionsHtml, /settings\.language/);
});

test("the popup exposes download handoff without browser playback or subtitle controls", async () => {
  const { popupHtml, popupJs } = await readOwned();
  assert.match(popupJs, /download-candidate/);
  assert.doesNotMatch(popupJs, /playback-addon|subtitle-settings|subtitle-folder/);
  assert.doesNotMatch(popupHtml, /<video|candidate-preview/);
});

async function launchPopupLayoutBrowser() {
  const launchers = [
    () => chromium.launch({ channel: "chrome", headless: true }),
    () => chromium.launch({ channel: "msedge", headless: true }),
    () => chromium.launch({ headless: true }),
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

test("long popup content stays vertically reachable on the document scroller", async (context) => {
  if (!chromium) {
    context.skip("Playwright is not installed in this environment");
    return;
  }
  let browser;
  try {
    browser = await launchPopupLayoutBrowser();
  } catch {
    context.skip("Chrome or Edge is not available for the optional layout probe");
    return;
  }
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
