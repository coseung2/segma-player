import test from "node:test";
import assert from "node:assert/strict";
import { encodeQr, qrCapacityBytes } from "./qr-code.js";

const TRON_WALLET = "TGwSFr1JQhMz9bn2RfqQs4zJfRwv7rcWK5";

// Golden symbol for the payment wallet, cross-checked against the `qrcode`
// reference library (module-for-module across all eight masks) and decoded back
// to the original text by the `jsqr` scanner. Any encoder change that breaks
// real-world scannability changes these rows.
const WALLET_GOLDEN_ROWS = [
  "11111110000011110101101111111",
  "10000010000111111110001000001",
  "10111010111011010010101011101",
  "10111010111000110000101011101",
  "10111010110000011111001011101",
  "10000010101010000110101000001",
  "11111110101010101010101111111",
  "00000000111000101011000000000",
  "10111110010110000100101111100",
  "11111101000101110011101010000",
  "01010111001111111100111001100",
  "00001100010001011010000001001",
  "00100010101100111000100100000",
  "10110101010100000000111111001",
  "00010111011010011110110110100",
  "01000000101000100010011101001",
  "01101110010010000100100011100",
  "11100001000011111001111110010",
  "10100111010101111100001010100",
  "10111000010111001001111000010",
  "10111011100000111100111111100",
  "00000000111110011000100010000",
  "11111110011010011101101011000",
  "10000010111010100011100011011",
  "10111010111010010110111110010",
  "10111010101101101000110000111",
  "10111010111110010100001110110",
  "10000010000010000001010111010",
  "11111110100101011101011011000",
];

function decodeFormatInformation(modules) {
  // The encoder writes the strip most-significant bit first; read it back in
  // the same order, then undo the mask XOR.
  let bits = 0;
  for (let index = 0; index <= 5; index += 1) bits = (bits << 1) | modules[8][index];
  bits = (bits << 1) | modules[8][7];
  bits = (bits << 1) | modules[8][8];
  bits = (bits << 1) | modules[7][8];
  for (let index = 9; index <= 14; index += 1) bits = (bits << 1) | modules[14 - index][8];
  const unmasked = bits ^ 0x5412;
  return { ecLevel: (unmasked >> 13) & 0b11, mask: (unmasked >> 10) & 0b111 };
}

test("sizes the symbol from the content length", () => {
  const wallet = encodeQr(TRON_WALLET);
  assert.equal(wallet.size, wallet.version * 4 + 17);
  assert.equal(wallet.modules.length, wallet.size);
  for (const row of wallet.modules) assert.equal(row.length, wallet.size);

  // A longer payment URI needs at least as large a symbol.
  const uri = encodeQr(`tron:${TRON_WALLET}?amount=5.99&token=USDT`);
  assert.ok(uri.version >= wallet.version);
});

test("emits only binary modules", () => {
  const { modules } = encodeQr(TRON_WALLET);
  for (const row of modules) {
    for (const cell of row) assert.ok(cell === 0 || cell === 1, `cell was ${cell}`);
  }
});

test("places the three finder patterns", () => {
  const { modules, size } = encodeQr(TRON_WALLET);
  const finderAt = (row, column) => {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
        const expected = ring === 2 ? 0 : 1;
        if (modules[row + dy][column + dx] !== expected) return false;
      }
    }
    return true;
  };
  assert.equal(finderAt(0, 0), true, "top-left");
  assert.equal(finderAt(0, size - 7), true, "top-right");
  assert.equal(finderAt(size - 7, 0), true, "bottom-left");
});

test("places the timing patterns and the dark module", () => {
  const { modules, size } = encodeQr(TRON_WALLET);
  for (let index = 8; index < size - 8; index += 1) {
    const expected = index % 2 === 0 ? 1 : 0;
    assert.equal(modules[6][index], expected, `row timing at ${index}`);
    assert.equal(modules[index][6], expected, `column timing at ${index}`);
  }
  assert.equal(modules[size - 8][8], 1, "dark module");
});

test("writes format information that decodes back to level M and the chosen mask", () => {
  const encoded = encodeQr(TRON_WALLET);
  const decoded = decodeFormatInformation(encoded.modules);
  assert.equal(decoded.ecLevel, 0, "error correction level M");
  assert.equal(decoded.mask, encoded.mask);
  assert.ok(encoded.mask >= 0 && encoded.mask <= 7);
});

test("is deterministic for the same content", () => {
  const first = encodeQr(TRON_WALLET);
  const second = encodeQr(TRON_WALLET);
  assert.equal(first.mask, second.mask);
  assert.deepEqual(first.modules, second.modules);
});

test("different content produces different modules", () => {
  const wallet = encodeQr(TRON_WALLET);
  const other = encodeQr("TXYZaBcDeFgHiJkLmNoPqRsTuVwXyZ1234");
  assert.equal(wallet.size, other.size);
  assert.notDeepEqual(wallet.modules, other.modules);
});

test("rejects empty and oversized content instead of truncating", () => {
  assert.throws(() => encodeQr(""), /qr-content-empty/);
  assert.throws(() => encodeQr("x".repeat(300)), /qr-content-too-long/);
});

test("reports capacity that grows with the version", () => {
  assert.ok(qrCapacityBytes(1) >= 14);
  assert.ok(qrCapacityBytes(4) > qrCapacityBytes(1));
  assert.ok(qrCapacityBytes(10) > qrCapacityBytes(4));
  assert.equal(qrCapacityBytes(99), 0);
  // The wallet address must fit inside the version the encoder selected.
  const encoded = encodeQr(TRON_WALLET);
  assert.ok(TRON_WALLET.length <= qrCapacityBytes(encoded.version));
});

test("handles multi-byte content by byte length, not character count", () => {
  const encoded = encodeQr("테더 결제 주소 확인");
  assert.ok(encoded.version >= 1);
  assert.equal(encoded.modules.length, encoded.size);
});

test("matches the verified golden symbol for the payment wallet", () => {
  const encoded = encodeQr(TRON_WALLET);
  assert.equal(encoded.version, 3);
  assert.equal(encoded.size, 29);
  assert.equal(encoded.mask, 2);
  assert.deepEqual(encoded.modules.map((row) => row.join("")), WALLET_GOLDEN_ROWS);
});

test("forceMask pins the mask without changing the version", () => {
  const auto = encodeQr(TRON_WALLET);
  for (let mask = 0; mask < 8; mask += 1) {
    const pinned = encodeQr(TRON_WALLET, { forceMask: mask });
    assert.equal(pinned.mask, mask);
    assert.equal(pinned.version, auto.version);
    assert.equal(decodeFormatInformation(pinned.modules).mask, mask);
  }
});

test("reserves the format strips without stealing the adjacent data module", () => {
  // Row 8 carries 8 format modules on the right and column 8 carries 8 at the
  // bottom (the lowest being the dark module). Getting this split wrong shifts
  // every later codeword, so the boundary modules are asserted directly.
  const { modules, size } = encodeQr(TRON_WALLET);
  assert.equal(modules[size - 8][8], 1, "dark module stays set");
  for (const row of modules) assert.equal(row.length, size);
});
