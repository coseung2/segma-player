import test from "node:test";
import assert from "node:assert/strict";
import {
  cuesAt,
  decodeSubtitleBytes,
  mediaIdentifier,
  parseSrt,
  subtitleNameMatches,
} from "./player-subtitle.js";

test("media identifier extraction mirrors the protocol handler", () => {
  assert.equal(mediaIdentifier("JUQ-546-카케이 준-유모자막"), "JUQ-546");
  assert.equal(mediaIdentifier("juq-921.srt"), "JUQ-921");
  assert.equal(mediaIdentifier("ABC_1234 title"), "ABC-1234");
  assert.equal(mediaIdentifier("plain title"), null);
  assert.equal(mediaIdentifier(""), null);
});

test("subtitle name matching tolerates separators and case", () => {
  assert.equal(subtitleNameMatches("juq-921.srt", "JUQ-921"), true);
  assert.equal(subtitleNameMatches("JUQ_921_니시노미야.srt", "JUQ-921"), true);
  assert.equal(subtitleNameMatches("JUQ 921.srt", "JUQ-921"), true);
  assert.equal(subtitleNameMatches("ABC-123.srt", "JUQ-921"), false);
});

test("SRT parsing handles CRLF, multiline cues, and ordering", () => {
  const text = [
    "1",
    "00:00:00,500 --> 00:00:03,000",
    "첫 번째",
    "",
    "2",
    "00:00:03,100 --> 00:00:06,000",
    "두 번째 줄",
    "두 번째 줄 2",
    "",
    "3",
    "00:01:00,000 --> 00:01:02,500",
    "세 번째",
    "",
  ].join("\r\n");
  const cues = parseSrt(text);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start: 0.5, end: 3, text: "첫 번째" });
  assert.equal(cues[1].text, "두 번째 줄\n두 번째 줄 2");
  assert.equal(cues[2].start, 60);
  assert.equal(cuesAt(cues, 1).text, "첫 번째");
  assert.equal(cuesAt(cues, 3.05), null);
  assert.equal(cuesAt(cues, 60.5).text, "세 번째");
});

test("subtitle decoding falls back to euc-kr for CP949 bytes", async () => {
  const encoder = new TextEncoder();
  const utf8 = await decodeSubtitleBytes(encoder.encode("자막 테스트 123"));
  assert.equal(utf8, "자막 테스트 123");
  const cp949 = new Uint8Array([
    0xC0, 0xDA, 0xB8, 0xB7, 0x20, 0xC5, 0xD7, 0xBD, 0xBA, 0xC6, 0xAE, 0x20, 0x31, 0x32, 0x33,
  ]);
  const legacy = await decodeSubtitleBytes(cp949);
  assert.equal(legacy, "자막 테스트 123");
});
