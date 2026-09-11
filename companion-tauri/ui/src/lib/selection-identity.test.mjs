import assert from "node:assert/strict";
import test from "node:test";
import {
  mediaFolderMatches,
  mediaIdentity,
  mediaIdentityMatches,
  mediaIdentityProbe,
} from "./selection-identity.ts";

test("folder and file identity stays distinct across same-named media", () => {
  const first = mediaIdentity("Season\\One", " clip.mp4 ");
  const second = mediaIdentity("Season/Two", "clip.mp4");
  assert.notEqual(first, second);
  assert.equal(mediaIdentityMatches(first, "Season/One", "clip.mp4"), true);
  assert.equal(mediaIdentityMatches(first, "Season/Two", "clip.mp4"), false);
  assert.equal(mediaFolderMatches(first, "Season/One"), true);
});

test("a response captured for the old selection is stale after a folder switch", () => {
  const initiating = mediaIdentity("Season/One", "clip.mp4");
  assert.equal(mediaIdentityMatches(initiating, "Season/Two", "clip.mp4"), false);
  assert.equal(mediaIdentityMatches(initiating, "Season/One", "clip.mp4"), true);
});

test("the exported deterministic probe reports the folder distinction", () => {
  assert.equal(mediaIdentityProbe().distinct, true);
});
