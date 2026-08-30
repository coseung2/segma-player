import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FILENAME_TEMPLATE,
  FILENAME_TEMPLATE_TOKENS,
  MAX_FILENAME_LENGTH,
  formatFilenameTemplate,
  normalizeFilenameTemplate,
  sanitizeFilename,
} from "./filename-template.js";

test("formats the documented tokens from a deterministic timestamp", () => {
  const result = formatFilenameTemplate(
    "{title}-{filename}-{ext}-{host}-{date}-{time}-{year}-{month}-{day}-{sequence}",
    {
      title: "Episode: 01",
      filename: "source.webm",
      ext: "mp4",
      host: "cdn.example",
      sequence: 7,
      now: new Date("2026-08-14T03:04:05.000Z"),
    },
  );
  assert.equal(
    result,
    "Episode_ 01-source.webm-mp4-cdn.example-2026-08-14-03-04-05-2026-08-14-7",
  );
});

test("uses a safe default and derives an extension when the caller omits one", () => {
  assert.equal(DEFAULT_FILENAME_TEMPLATE, "{title}.{ext}");
  assert.equal(
    formatFilenameTemplate(undefined, { title: "Lecture", filename: "lecture.webm" }),
    "Lecture.webm",
  );
  assert.equal(formatFilenameTemplate("", { title: "Only title" }), "Only title");
  assert.equal(normalizeFilenameTemplate(""), DEFAULT_FILENAME_TEMPLATE);
});

test("sanitizes Windows separators, traversal-looking names, reserved names, and length", () => {
  const result = formatFilenameTemplate("{title}.{ext}", {
    title: "CON",
    ext: "mp4/../bad",
  });
  assert.equal(result, "_CON.mp4_.._bad");
  assert.equal(formatFilenameTemplate("{title}", { title: "..\\secret/clip" }), ".._secret_clip");
  assert.equal(
    formatFilenameTemplate("{title}", { title: "x".repeat(MAX_FILENAME_LENGTH + 40) }).length,
    MAX_FILENAME_LENGTH,
  );
  assert.equal(sanitizeFilename(""), "aura-media");
  assert.equal(sanitizeFilename("CON.txt"), "_CON.txt");
});

test("only allowlisted tokens are substituted and replacement values are not re-evaluated", () => {
  const result = formatFilenameTemplate(
    "{title}-{__proto__}-{title.toString()}-{sequence}",
    { title: "{host}", sequence: 2, host: "should-not-be-injected" },
  );
  assert.equal(result, "{host}---2");
  assert.equal(result.includes("should-not-be-injected"), false);
  assert.deepEqual(FILENAME_TEMPLATE_TOKENS, [
    "title", "filename", "ext", "host", "date", "time", "year", "month", "day", "sequence",
  ]);
});

test("sequence values distinguish otherwise-colliding output names", () => {
  const first = formatFilenameTemplate("{title}-{sequence}.{ext}", {
    title: "same/video",
    sequence: 1,
    ext: "mp4",
  });
  const second = formatFilenameTemplate("{title}-{sequence}.{ext}", {
    title: "same\\video",
    sequence: 2,
    ext: "mp4",
  });
  assert.notEqual(first, second);
  assert.equal(first, "same_video-1.mp4");
  assert.equal(second, "same_video-2.mp4");
});
