import test from "node:test";
import assert from "node:assert/strict";

import { createPlaybackSessionStore } from "./playback-session.js";

function candidate(id = "candidate-1", token = "one") {
  return {
    id,
    tabId: 7,
    frameId: 3,
    pageTitle: "Video",
    pageUrl: "https://player.example/embed/1",
    resourceUrl: `https://cdn.example/master.m3u8?token=${token}`,
    mediaType: "HLS_MASTER",
    variants: [{ resourceUrl: "https://cdn.example/alternate.m3u8?token=two" }],
    evidence: [{ source: "player-adapter", player: "hls.js", confidence: 100 }],
  };
}

test("playback sessions retain exact token URLs without exposing them in identifiers", () => {
  let at = 1_700_000_000_000;
  const store = createPlaybackSessionStore({
    now: () => at,
    idFactory: () => "12345678-1234-1234-1234-123456789abc",
  });
  const session = store.create(candidate(), { sourceUrl: "https://page.example/watch" });
  assert.ok(session);
  assert.equal(session.id.includes("token"), false);
  assert.match(session.candidate.resourceUrl, /token=one/);
  assert.equal("evidence" in session.candidate, false);
  assert.equal("variants" in session.candidate, false);
  assert.equal(session.sourceUrl, "https://page.example/watch");

  at += 1_000;
  const touched = store.get(session.id);
  assert.ok(touched.expiresAt > session.expiresAt);
});

test("session candidate updates preserve the session while rotating token URLs", () => {
  const store = createPlaybackSessionStore({
    idFactory: () => "12345678-1234-1234-1234-123456789abc",
  });
  const session = store.create(candidate());
  const updated = store.updateCandidate(session.id, candidate("candidate-1", "fresh"));
  assert.equal(updated.id, session.id);
  assert.match(updated.candidate.resourceUrl, /token=fresh/);
  assert.equal(store.size, 1);
});

test("expired sessions are discarded during restore and lookup", () => {
  let at = 10_000;
  const store = createPlaybackSessionStore({
    ttlMs: 1_000,
    now: () => at,
    idFactory: () => "12345678-1234-1234-1234-123456789abc",
  });
  const session = store.create(candidate());
  const serialized = store.serialized();
  at = session.expiresAt + 1;
  assert.equal(store.get(session.id), null);

  const restored = createPlaybackSessionStore({ ttlMs: 1_000, now: () => at });
  assert.equal(restored.restore(serialized), 0);
});

test("the store stays bounded and rejects non-HTTP candidate contexts", () => {
  let next = 0;
  const store = createPlaybackSessionStore({
    maxEntries: 2,
    idFactory: () => `12345678-1234-1234-1234-${String(++next).padStart(12, "0")}`,
  });
  const first = store.create(candidate("one"));
  const second = store.create(candidate("two"));
  const third = store.create(candidate("three"));
  assert.equal(store.size, 2);
  assert.equal(store.get(first.id), null);
  assert.ok(store.get(second.id));
  assert.ok(store.get(third.id));
  assert.equal(store.create({ ...candidate(), pageUrl: "javascript:alert(1)" }), null);
});
