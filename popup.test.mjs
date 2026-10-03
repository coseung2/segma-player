import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createCandidateRepository } from "./background-candidate-repository.js";

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

// Run the popup's actual rescan and injected scripts against a small DOM realm.
// The real candidate repository turns reported media into the returned selection.
async function rescanEnvironment({ missingDependency = false, jwSource = "" } = {}) {
  const files = {};
  for (const name of ["content-extraction.js", "content.js", "page-media-observer.js"]) {
    files[name] = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
  }
  const repository = createCandidateRepository();
  const pendingMessages = [];
  const videoUrl = jwSource ? "blob:https://player.example/video" : "https://cdn.example/recovered.mp4";
  class MediaElement {
    constructor() { this.tagName = "VIDEO"; this.src = ""; this.currentSrc = videoUrl; this.paused = false; this.type = "video/mp4"; }
    getBoundingClientRect() { return { width: 640, height: 360 }; }
    querySelectorAll() { return []; }
    getAttribute() { return null; }
  }
  const video = new MediaElement();
  const frame = vm.createContext({
    URL, Element: MediaElement, crypto: { randomUUID }, atob, console,
    location: new URL("https://player.example/e/test"),
    innerWidth: 1280, innerHeight: 720,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    setInterval: () => ({ unref() {} }), clearInterval() {},
    MutationObserver: class { observe() {} },
    performance: { getEntriesByType: () => [] },
    document: {
      title: "Player fixture", documentElement: {},
      querySelector: () => null,
      querySelectorAll: (selector) => selector === "video, audio, source" ? [video] : [],
      addEventListener() {},
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(message) {
        if (message.type === "resource") repository.observeResource({ ...message,
          pageUrl: "https://player.example/e/test", siteUrl: "https://page.example/watch", frameId: 1 }, 7);
        return Promise.resolve();
      },
    } },
    Event: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(`window = globalThis; top = globalThis;
    const listeners = new Map();
    addEventListener = (type, fn) => {
      const handlers = listeners.get(type) || [];
      handlers.push(fn); listeners.set(type, handlers);
    };
    dispatchEvent = event => { for (const fn of listeners.get(event.type) || []) fn(event); };`, frame);
  // postMessage is asynchronous in Chrome; deliver after the executing script.
  frame.__enqueue = data => pendingMessages.push(data);
  vm.runInContext("postMessage = data => __enqueue(data);", frame);
  const flush = () => {
    while (pendingMessages.length) {
      frame.__messageData = pendingMessages.shift();
      vm.runInContext("dispatchEvent({type: 'message', source: window, data: __messageData})", frame);
    }
  };
  if (jwSource) {
    frame.__jwSource = jwSource;
    vm.runInContext(`jwplayer = () => player;
      player = { getPlaylistItem: () => ({file:__jwSource,type:'application/vnd.apple.mpegurl'}), getConfig: () => ({}), getPlaylist: () => [] };
      jwplayer.api = {players:[player]};`, frame);
    vm.runInContext(files["page-media-observer.js"], frame);
    vm.runInContext("jwplayer()", frame);
  }
  if (!missingDependency) {
    vm.runInContext(files["content-extraction.js"], frame);
    vm.runInContext(files["content.js"], frame);
    flush();
    vm.runInContext("dispatchEvent(new Event('aura-media-detector-rescan-v1'))", frame);
    flush();
  }
  const { popupJs } = await readOwned();
  const rescanSource = popupJs.slice(popupJs.indexOf("async function rescan()"), popupJs.indexOf("function applyLocale("));
  const button = { disabled: false };
  const popup = vm.createContext({
    byId: () => button,
    window: { setTimeout: (fn) => fn() },
    sendBackground: async message => { if (message.type === "clear-tab") repository.clearTab(7); },
    requestCandidates: async () => repository.rerankTabCandidates(7).length,
    RESCAN_EVENT_TYPE: "aura-media-detector-rescan-v1",
    chrome: {
      tabs: { query: async () => [{ id: 7 }] },
      scripting: { executeScript: async ({ files: requested, func, args }) => {
        if (requested) for (const name of requested) vm.runInContext(files[name], frame);
        if (func) { frame.__args = args; vm.runInContext(`(${func.toString()})(...__args)`, frame); }
        flush();
      } },
    },
  });
  vm.runInContext(rescanSource, popup);
  return { frame, files, flush, repository, rescan: () => vm.runInContext("rescan()", popup) };
}

test("popup rescan initializes a missing frame and selects its media on repeated scans", async () => {
  const env = await rescanEnvironment({ missingDependency: true });
  for (let scan = 0; scan < 2; scan += 1) {
    await env.rescan();
    const primary = env.repository.rerankTabCandidates(7).find(candidate => candidate.main);
    assert.equal(primary?.resourceUrl, "https://cdn.example/recovered.mp4");
  }
});

test("popup rescan restores the unchanged JW source behind a blob video", async () => {
  const source = "https://cdn.example/master.m3u8?token=fixture";
  const env = await rescanEnvironment({ jwSource: source });
  assert.equal(env.repository.rerankTabCandidates(7).find(c => c.main)?.player, "jwplayer");
  for (let scan = 0; scan < 2; scan += 1) {
    await env.rescan();
    const primary = env.repository.rerankTabCandidates(7).find(c => c.main);
    assert.equal(primary?.resourceUrl, source);
    assert.equal(primary?.player, "jwplayer");
  }
});

test("rescan keeps a manifest that was only observed before the scan", async () => {
  // LuluStream: the JW manifest was seen once on the network; the frame's
  // detector does not report it again, so a rescan must not discard it.
  const env = await rescanEnvironment({ missingDependency: true });
  const manifest = "https://cdn.example/hls2/master.m3u8?t=fixture";
  env.repository.observeResource({
    resourceUrl: manifest,
    contentType: "application/vnd.apple.mpegurl",
    pageUrl: "https://player.example/e/test",
    siteUrl: "https://page.example/watch",
    frameId: 1,
    detectionSource: "web-request",
  }, 7);
  const before = env.repository.rerankTabCandidates(7).find((candidate) => candidate.resourceUrl === manifest);
  assert.ok(before, "fixture manifest is observed");
  await env.rescan();
  const after = env.repository.rerankTabCandidates(7).find((candidate) => candidate.resourceUrl === manifest);
  assert.equal(after?.id, before.id, "the same candidate id stays downloadable after rescan");
});

test("a failed content startup can recover once its dependency is supplied", async () => {
  const env = await rescanEnvironment({ missingDependency: true });
  assert.throws(() => vm.runInContext(env.files["content.js"], env.frame), /content-extraction-unavailable/);
  vm.runInContext(env.files["content-extraction.js"], env.frame);
  vm.runInContext(env.files["content.js"], env.frame);
  env.flush();
  assert.equal(env.repository.rerankTabCandidates(7).find(c => c.main)?.resourceUrl,
    "https://cdn.example/recovered.mp4");
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
