import test from "node:test";
import assert from "node:assert/strict";
import { aesCbcDecrypt } from "./aes-cbc.js";
import {
  activeKeyForSegment,
  chooseHlsAudioRendition,
  chooseHlsVariant,
  decryptSegment,
  hlsFileExtension,
  isHlsPlaylist,
  ivForSegment,
  parseHlsPlaylist,
} from "./hls.js";

test("parses HLS master playlists and selects the highest bandwidth variant", () => {
  const parsed = parseHlsPlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720\nhigh/index.m3u8`, "https://media.example/root/master.m3u8");
  assert.equal(chooseHlsVariant(parsed.variants).uri, "https://media.example/root/high/index.m3u8");
});

test("parses and selects a separate HLS audio rendition", () => {
  const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,AUTOSELECT=YES,URI="audio/ja.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="stereo"
video/720p.m3u8`, "https://media.example/root/master.m3u8");
  assert.equal(parsed.audioRenditions.length, 2);
  assert.equal(chooseHlsAudioRendition(parsed.audioRenditions).uri, "https://media.example/root/audio/ja.m3u8");
  assert.equal(chooseHlsAudioRendition(parsed.audioRenditions, "en").uri, "https://media.example/root/audio/en.m3u8");
  assert.equal(parsed.variants[0].audioGroup, "stereo");
  assert.equal(parsed.variants[0].codecs, "avc1.4d401f,mp4a.40.2");
});

test("rejects HTML/CSS responses that are not playlists", () => {
  assert.equal(isHlsPlaylist("<!doctype html><style>.wp-block{color:red}</style>", "text/html"), false);
  assert.equal(isHlsPlaylist("#EXTM3U\n#EXTINF:4,\nseg.ts", ""), true);
  assert.equal(isHlsPlaylist("#EXT-X-STREAM-INF:BANDWIDTH=1000\nhigh.m3u8", ""), true);
  assert.equal(isHlsPlaylist("<html>page</html>", "application/vnd.apple.mpegurl"), true);
});

test("parses relative media segments and identifies encrypted playlists", () => {
  const parsed = parseHlsPlaylist(`#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.m4s\n#EXTINF:4,\nseg-2.m4s`, "https://media.example/video/stream.m3u8");
  assert.equal(parsed.initUrl, "https://media.example/video/init.mp4");
  assert.deepEqual(parsed.segments, ["https://media.example/video/seg-1.m4s", "https://media.example/video/seg-2.m4s"]);
  assert.equal(hlsFileExtension(parsed.initUrl, parsed.segments), "mp4");
  assert.equal(parseHlsPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=key.bin\nseg.ts", "https://media.example/x.m3u8").encrypted, true);
});

test("parses AES-128 keys, media sequence, and explicit IVs", () => {
  const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-KEY:METHOD=AES-128,URI=keys/rotating.key,IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4,
seg-1.ts
#EXTINF:4,
seg-2.ts`, "https://media.example/video/stream.m3u8");
  assert.equal(parsed.mediaSequence, 100);
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.keys.length, 1);
  assert.equal(parsed.keys[0].method, "AES-128");
  assert.equal(parsed.keys[0].uri, "https://media.example/video/keys/rotating.key");
  assert.equal(parsed.keys[0].startIndex, 0);
  assert.deepEqual(parsed.keys[0].iv, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
  assert.equal(activeKeyForSegment(parsed.keys, 0).method, "AES-128");
  assert.equal(activeKeyForSegment(parsed.keys, 99).method, "AES-128");
});

test("parses EXT-X-BYTERANGE segments including URI reuse", () => {
  const parsed = parseHlsPlaylist(`#EXTM3U
#EXTINF:4,
#EXT-X-BYTERANGE:1000@0
seg.bin
#EXTINF:4,
#EXT-X-BYTERANGE:500
#EXTINF:4,
#EXT-X-BYTERANGE:700@2500
seg.bin`, "https://media.example/video/stream.m3u8");
  assert.equal(parsed.byterange, true);
  assert.deepEqual(parsed.segments, [
    "https://media.example/video/seg.bin",
    "https://media.example/video/seg.bin",
    "https://media.example/video/seg.bin",
  ]);
  assert.deepEqual(parsed.byteranges, [
    { length: 1000, offset: 0 },
    { length: 500, offset: 1000 },
    { length: 700, offset: 2500 },
  ]);
});

test("parses EXT-X-MAP BYTERANGE for fMP4 init sections", () => {
  const parsed = parseHlsPlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n#EXTINF:4,\nseg.m4s',
    "https://media.example/video/stream.m3u8",
  );
  assert.deepEqual(parsed.initByterange, { length: 720, offset: 0 });
  assert.equal(parsed.initUrl, "https://media.example/video/init.mp4");
});

test("derives per-segment IVs from the media sequence when no IV is given", () => {
  const key = { iv: null };
  assert.deepEqual(ivForSegment(key, 100, 0), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100]));
  assert.deepEqual(ivForSegment(key, 100, 1), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 101]));
});

test("decrypts AES-128 HLS segments and handles missing PKCS#7 padding", async (t) => {
  if (!globalThis.crypto?.subtle) return t.skip("Web Crypto unavailable");
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const plaintext = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    plaintext,
  ));
  assert.deepEqual(await decryptSegment(ciphertext, keyBytes, iv), plaintext);

  // Simulate a stream that omits the final padding block by dropping it.
  const unpadded = ciphertext.slice(0, ciphertext.length - 16);
  assert.deepEqual(await decryptSegment(unpadded, keyBytes, iv), plaintext);
});

test("decrypts AES-256 HLS segments with a 32-byte key", async (t) => {
  if (!globalThis.crypto?.subtle) return t.skip("Web Crypto unavailable");
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const plaintext = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    plaintext,
  ));
  assert.deepEqual(await decryptSegment(ciphertext, keyBytes, iv), plaintext);

  const parsed = parseHlsPlaylist(
    "#EXTM3U\n#EXT-X-KEY:METHOD=AES-256,URI=key.bin\n#EXTINF:4,\nseg.ts",
    "https://media.example/stream.m3u8",
  );
  assert.equal(parsed.keys[0].method, "AES-256");
});

test("pure-JS AES-CBC decrypts padded ciphertext without WebCrypto padding checks", async (t) => {
  if (!globalThis.crypto?.subtle) return t.skip("Web Crypto unavailable");
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const plaintext = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    cryptoKey,
    plaintext,
  ));
  const raw = aesCbcDecrypt(ciphertext, keyBytes, iv);
  assert.deepEqual(raw.subarray(0, plaintext.byteLength), plaintext);
  assert.equal(raw.byteLength, plaintext.byteLength + 16);
  assert.ok(raw.subarray(plaintext.byteLength).every((value) => value === 16));
});

test("decrypts a full encrypted HLS media playlist end to end", async (t) => {
  if (!globalThis.crypto?.subtle) return t.skip("Web Crypto unavailable");
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const plain1 = new TextEncoder().encode("0000000000000000");
  const plain2 = new TextEncoder().encode("1111111111111111");
  const playlist = `#EXTM3U
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-KEY:METHOD=AES-128,URI=keys/stream.key
#EXTINF:4,
seg-1.ts
#EXTINF:4,
seg-2.ts`;
  const parsed = parseHlsPlaylist(playlist, "https://media.example/video/stream.m3u8");
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.mediaSequence, 100);
  assert.equal(parsed.keys[0].uri, "https://media.example/video/keys/stream.key");
  assert.equal(activeKeyForSegment(parsed.keys, 1).startIndex, 0);

  const chunks = [];
  for (let index = 0; index < parsed.segments.length; index += 1) {
    const key = activeKeyForSegment(parsed.keys, index);
    const iv = ivForSegment(key, parsed.mediaSequence, index);
    const plaintext = index === 0 ? plain1 : plain2;
    const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      plaintext,
    ));
    chunks.push(await decryptSegment(ciphertext, keyBytes, iv));
  }
  const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(merged.toString(), "00000000000000001111111111111111");
});
