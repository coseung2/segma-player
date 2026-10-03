import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./routes/PlayerView.svelte", import.meta.url), "utf8");
// Execute the actual event adapters, keeping the video and native extraction
// outside this input-only probe. The scheduler is tested separately.
const handlers = source.slice(source.indexOf("  function handleSeekPointerMove("), source.indexOf("  function scheduleSeekPreview("));
function inputHarness() {
  const requests = [];
  const seeks = [];
  let clears = 0;
  const document = { activeElement: null };
  const create = new Function("document", "requests", "seeks", "clear", `
    let selection = {}; let duration = 10; let hoverTime = null; let hoverPercent = 0;
    const scheduleSeekPreview = (time) => requests.push(time);
    const seekTo = (time) => seeks.push(time);
    const clearSeekPreview = () => { hoverTime = null; clear(); };
    ${stripTypeScriptTypes(handlers)}
    return { handleSeekInput, handleSeekPointerMove, handleSeekPointerLeave, showSeekPreview,
      state: () => ({ hoverTime, hoverPercent }) };
  `);
  return { ...create(document, requests, seeks, () => { clears++; }), document, requests, seeks, clears: () => clears };
}

test("keyboard range changes seek and request a matching visible preview position", () => {
  const h = inputHarness();
  h.handleSeekInput({ currentTarget: { value: "4.2" } });
  assert.deepEqual(h.seeks, [4.2]);
  assert.deepEqual(h.requests, [4.2]);
  assert.equal(h.state().hoverTime, 4.2);
  assert.ok(Math.abs(h.state().hoverPercent - 42) < 0.001);
  assert.match(source, /oninput=\{handleSeekInput\}/);
  assert.match(source, /onfocus=\{\(event\) => showSeekPreview/);
  assert.match(source, /onblur=\{clearSeekPreview\}/);
});

test("pointer mapping clamps both track ends and mouse leave dismisses", () => {
  const h = inputHarness();
  const track = { getBoundingClientRect: () => ({ left: 100, width: 200 }), querySelector: () => null };
  h.handleSeekPointerMove({ currentTarget: track, clientX: 50 });
  h.handleSeekPointerMove({ currentTarget: track, clientX: 400 });
  assert.deepEqual(h.requests, [0, 10]);
  h.handleSeekPointerLeave({ currentTarget: track, pointerType: "mouse" });
  assert.equal(h.state().hoverTime, null);
  assert.equal(h.clears(), 1);
});

test("touch release retains the selected preview only while slider focus remains", () => {
  const h = inputHarness();
  const slider = { value: "6" };
  const track = { querySelector: () => slider };
  h.document.activeElement = slider;
  h.handleSeekInput({ currentTarget: slider });
  h.handleSeekPointerLeave({ currentTarget: track, pointerType: "touch" });
  assert.equal(h.state().hoverTime, 6);
  h.document.activeElement = null;
  h.handleSeekPointerLeave({ currentTarget: track, pointerType: "touch" });
  assert.equal(h.state().hoverTime, null);
});
