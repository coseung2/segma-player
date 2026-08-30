import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { avseeSite } from "./sites/avsee/profile.js";
import { avseePlayerFrameUrl, avseeTitleFixtures } from "./sites/avsee/regressions.js";
import { isPlayerFrameUrl, siteProfileForUrls, titleSelectorsForPage } from "./sites/registry.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BOARD_URL = "https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512";

/**
 * Mirrors the content script's resolver so the selector contract is testable
 * without a browser. Kept deliberately small: it must stay behaviourally equal
 * to `resolvedPageTitle()` in content.js, and the last test asserts that the
 * shipped implementation still uses the same two rules.
 */
function resolveTitle({ documentTitle, bodyHtml, selectors }) {
  const trimmedDocumentTitle = documentTitle.trim();
  for (const selector of selectors) {
    const match = matchFirst(bodyHtml, selector);
    if (!match) continue;
    const text = match.replace(/\s+/g, " ").trim();
    if (text && text !== trimmedDocumentTitle) return text;
  }
  return documentTitle;
}

/**
 * Minimal stand-in for `querySelector` covering only the shapes these fixtures
 * use: `.class h2` and `[attr='value'] h2`. A real DOM is not available here,
 * and a full parser would test the parser rather than the contract.
 */
function matchFirst(html, selector) {
  const descendant = selector.match(/^(\.[\w-]+|\[[\w-]+='[^']+'\]|#[\w-]+)\s+(\w+)$/);
  if (!descendant) return null;
  const [, container, tag] = descendant;

  let containerPattern;
  if (container.startsWith(".")) {
    containerPattern = `class="[^"]*\\b${container.slice(1)}\\b[^"]*"`;
  } else if (container.startsWith("#")) {
    containerPattern = `id="${container.slice(1)}"`;
  } else {
    const attribute = container.slice(1, -1);
    const [name, rawValue] = attribute.split("=");
    containerPattern = `${name}="${rawValue.replace(/'/g, "")}"`;
  }

  const open = new RegExp(`<[a-z]+[^>]*${containerPattern}[^>]*>`, "i");
  const start = html.search(open);
  if (start < 0) return null;
  const inner = html.slice(start);
  const element = inner.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return element ? element[1].replace(/<[^>]*>/g, "") : null;
}

test("the avsee profile is registered for the board host", () => {
  const profile = siteProfileForUrls(BOARD_URL);
  assert.equal(profile?.id, "avsee");
  assert.equal(profile, avseeSite);
});

test("title selectors are published for the page, not for the media host", () => {
  const selectors = titleSelectorsForPage(BOARD_URL, BOARD_URL);
  assert.ok(selectors.length > 0, "the board page must publish selectors");
  assert.equal(selectors[0], ".view-content h2");

  // A CDN never carries the page heading, so keying off the resource URL must
  // not produce selectors that cannot resolve.
  assert.deepEqual(
    titleSelectorsForPage("https://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4", ""),
    [],
  );
  assert.deepEqual(titleSelectorsForPage("https://example.com/watch", ""), []);
});

for (const fixture of avseeTitleFixtures) {
  test(`avsee title resolution: ${fixture.id}`, () => {
    const selectors = titleSelectorsForPage(BOARD_URL, BOARD_URL);
    const resolved = resolveTitle({
      documentTitle: fixture.documentTitle,
      bodyHtml: fixture.bodyHtml,
      selectors,
    });
    assert.equal(resolved, fixture.expectedTitle);
  });
}

test("the board page title alone is not enough for a filename", () => {
  // This is the reported defect: <title> holds only the board code, so a job
  // named from it loses the actual video title.
  const documentTitleOnly = "MFC-361";
  const resolved = resolveTitle({
    documentTitle: documentTitleOnly,
    bodyHtml: avseeTitleFixtures[0].bodyHtml,
    selectors: titleSelectorsForPage(BOARD_URL, BOARD_URL),
  });
  assert.notEqual(resolved, documentTitleOnly);
  assert.equal(resolved, "MFC-361 さな - 사나");
});

test("the player iframe is recognised so its own title is ignored", () => {
  assert.equal(isPlayerFrameUrl(avseePlayerFrameUrl), true);

  // Only the declared player path counts; the board page itself is not a frame
  // whose title should be replaced.
  assert.equal(isPlayerFrameUrl(BOARD_URL), false);
  assert.equal(isPlayerFrameUrl("https://01.avsee.is/player/other.php"), false);
  assert.equal(isPlayerFrameUrl("https://example.com/player/player.php"), false);
  assert.equal(isPlayerFrameUrl(""), false);
  assert.equal(isPlayerFrameUrl("not a url"), false);
});

test("selector count and length are bounded so a profile cannot bloat a frame", () => {
  const selectors = titleSelectorsForPage(BOARD_URL, BOARD_URL);
  assert.ok(selectors.length <= 8, `selector count ${selectors.length}`);
  for (const selector of selectors) {
    assert.ok(selector.length <= 200, selector);
    assert.equal(selector, selector.trim());
  }
  assert.equal(new Set(selectors).size, selectors.length, "selectors must be unique");
});

test("the content script resolver keeps both rules the fixtures rely on", async () => {
  const source = await readFile(path.join(ROOT, "content.js"), "utf8");

  // The selector list must arrive from the background, never be hardcoded here.
  assert.match(source, /set-title-selectors/);
  assert.doesNotMatch(source, /view-content/, "content.js must not hardcode site selectors");

  // Rule 1: a heading equal to the document title is skipped.
  assert.match(source, /text !== documentTitle\(\)\.trim\(\)/);
  // Rule 2: the document title remains the fallback.
  assert.match(source, /selectorTitle\(\) \|\| documentTitle\(\)/);
});

test("the background prefers the tab title for a player-frame candidate", async () => {
  const source = await readFile(path.join(ROOT, "background.js"), "utf8");
  assert.match(source, /isPlayerFrameUrl\(sender\.url\)/);
  // The tab title must win for a player frame, and the frame's own reported
  // title must still be the fallback when there is no tab title.
  assert.match(source, /\? sender\.tab\.title \|\| message\.pageTitle \|\| ""/);
});
