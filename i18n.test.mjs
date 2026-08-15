import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCALE,
  KOREAN_STATUS_PATTERNS,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
  detectLocale,
  localizeStatusText,
  normalizeLocale,
  translator,
} from "./i18n.js";

test("supports exactly the four shipped UI languages", () => {
  assert.deepEqual(SUPPORTED_LOCALES, ["ko", "en", "ja", "zh"]);
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(typeof LOCALE_NAMES[locale], "string");
    assert.ok(LOCALE_NAMES[locale].length > 0);
  }
});

test("normalizes region tags and rejects unsupported languages", () => {
  assert.equal(normalizeLocale("ko-KR"), "ko");
  assert.equal(normalizeLocale("en_US"), "en");
  assert.equal(normalizeLocale("ja"), "ja");
  assert.equal(normalizeLocale("zh-TW"), "zh");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(detectLocale("fr-FR"), DEFAULT_LOCALE);
  assert.equal(detectLocale("ja-JP"), "ja");
});

test("every locale defines the same message keys", () => {
  const reference = Object.keys(collectKeys("en")).sort();
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(collectKeys(locale)).sort(), reference, locale);
  }
});

function collectKeys(locale) {
  const t = translator(locale);
  const keys = {};
  for (const key of PROBE_KEYS) {
    const value = t(key);
    assert.notEqual(value, key, `${locale} is missing ${key}`);
    keys[key] = value;
  }
  return keys;
}

const PROBE_KEYS = [
  "app.heading", "app.settings", "plan.free", "plan.pro", "plan.summaryFree", "plan.summaryPro",
  "tab.detect", "tab.link", "detect.rescan", "detect.empty", "jobs.collapse", "jobs.clear",
  "media.progressive", "media.stream", "action.download", "action.cancel", "action.retry",
  "quality.label", "link.addressLabel", "save.path", "status.queued", "status.completed",
  "stage.saving", "msg.savingSegments", "overlay.heading", "app.language", "settings.license",
  "settings.activateKey", "settings.saveFolder", "settings.changeFolder", "settings.buyPro",
];

test("interpolates placeholders and falls back to English for unknown locales", () => {
  const ko = translator("ko");
  assert.equal(ko("detect.candidateCount", { count: 3 }), "3개 후보");
  assert.equal(ko("save.path", { name: "test" }), "저장 경로: test");
  const zh = translator("zh");
  assert.equal(zh("quality.cap", { height: 1080 }), "最高 1080p");
  const unknown = translator("fr");
  assert.equal(unknown.locale, DEFAULT_LOCALE);
  assert.equal(unknown("action.download"), "Download");
});

test("maps canonical Korean pipeline status lines onto the active locale", () => {
  const en = translator("en");
  assert.equal(localizeStatusText(en, "저장 중… 25/100"), "Saving… 25/100");
  assert.equal(localizeStatusText(en, "저장 중… 42% (13 MB)"), "Saving… 42% (13 MB)");
  assert.equal(localizeStatusText(en, "서버 처리 중… 80%"), "Server processing… 80%");
  assert.equal(localizeStatusText(en, "다운로드 대기 중…"), "Waiting to download…");
  const ja = translator("ja");
  assert.equal(localizeStatusText(ja, "일시정지 — 원래 페이지로 돌아가주세요."), "一時停止 — 元のページに戻ってください。");
  const ko = translator("ko");
  assert.equal(localizeStatusText(ko, "저장 중… 25/100"), "저장 중… 25/100");
});

test("keeps detailed pipeline failures verbatim instead of dropping information", () => {
  const en = translator("en");
  const detail = "저장 폴더 권한이 만료되었습니다. 다운로드 버튼을 다시 누르면 폴더를 다시 선택합니다.";
  assert.equal(localizeStatusText(en, detail), detail);
  assert.ok(KOREAN_STATUS_PATTERNS.every((entry) => entry.pattern.source.startsWith("^")));
});
