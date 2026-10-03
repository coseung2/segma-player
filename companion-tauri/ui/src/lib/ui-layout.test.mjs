import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "..", "app.css"), "utf8");

test("desktop shell keeps long views inside the content scroller", () => {
  assert.match(css, /\.app-shell \{[^}]*height: 100vh;[^}]*min-height: 0;[^}]*overflow: hidden;/s);
  assert.match(css, /\.content \{[^}]*min-height: 0;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
});

test("medium windows reflow subtitle actions instead of clipping them", () => {
  assert.match(css, /@media \(min-width: 721px\) and \(max-width: 1000px\)/);
  assert.match(css, /\.subtitle-action-grid \{ grid-template-columns: 1fr 1fr; \}/);
  assert.match(css, /\.subtitle-sync-row \{ grid-template-columns: 1fr 1fr; \}/);
});
