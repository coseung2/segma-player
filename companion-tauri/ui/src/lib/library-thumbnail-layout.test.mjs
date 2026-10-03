import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const stylePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app.css");
const stylesheet = await readFile(stylePath, "utf8");

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[1];
}

test("a library thumbnail owns the full width of its grid column", () => {
  // A <button> stays shrink-to-fit even with display:grid in Chromium. Without
  // an explicit width the 16/9 aspect ratio derives a tiny card from the button
  // content instead of the column, which is the reported thumbnail defect.
  const rule = declarations(".media-thumb");
  assert.match(rule, /width:\s*100%/, ".media-thumb must fill its grid column");
  assert.match(rule, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(rule, /display:\s*grid/);
});

test("a thumbnail image covers its container without distorting the source", () => {
  const rule = declarations(".media-thumb-image");
  assert.match(rule, /object-fit:\s*cover/);
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /height:\s*100%/);
});

test("list view gives the thumbnail a fixed column instead of the card width", () => {
  const rule = declarations(".media-list .media-tile");
  assert.match(rule, /grid-template-columns:\s*64px/);
});
