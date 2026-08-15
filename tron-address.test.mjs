import test from "node:test";
import assert from "node:assert/strict";
import {
  coversExpectedAmount,
  normalizeTronAddress,
  sameTronAddress,
  usdtMicroUnits,
} from "./tron-address.js";

const WALLET_BASE58 = "TGwSFr1JQhMz9bn2RfqQs4zJfRwv7rcWK5";
const WALLET_HEX_BODY = "4c731cfcd08b7729df01b11fab04d44126aabd8f";
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

test("decodes a base58 Tron address to its hex body", () => {
  assert.equal(normalizeTronAddress(WALLET_BASE58), WALLET_HEX_BODY);
  assert.equal(normalizeTronAddress(`41${WALLET_HEX_BODY}`), WALLET_HEX_BODY);
  assert.equal(normalizeTronAddress(`0x41${WALLET_HEX_BODY}`), WALLET_HEX_BODY);
  assert.equal(normalizeTronAddress(`0x${WALLET_HEX_BODY}`), WALLET_HEX_BODY);
  assert.equal(normalizeTronAddress(WALLET_HEX_BODY.toUpperCase()), WALLET_HEX_BODY);
});

test("rejects values that are not Tron addresses", () => {
  for (const bad of ["", null, undefined, "not-an-address", "0x1234", "T!!!", "41abc"]) {
    assert.equal(normalizeTronAddress(bad), null, String(bad));
  }
});

test("matches the TronGrid hex form against the configured base58 wallet", () => {
  // This is the exact shape TronGrid returns in `result.to`.
  assert.equal(sameTronAddress(`0x${WALLET_HEX_BODY}`, WALLET_BASE58), true);
  assert.equal(sameTronAddress(WALLET_BASE58, WALLET_BASE58), true);
  assert.equal(sameTronAddress(USDT_CONTRACT, "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"), true);
  assert.equal(sameTronAddress(WALLET_BASE58, USDT_CONTRACT), false);
  assert.equal(sameTronAddress(null, WALLET_BASE58), false);
});

test("converts USDT amounts to integer micro-units", () => {
  assert.equal(usdtMicroUnits(5.99), 5_990_000);
  assert.equal(usdtMicroUnits(49), 49_000_000);
  assert.equal(usdtMicroUnits("5.99"), 5_990_000);
  assert.equal(usdtMicroUnits("abc"), null);
});

test("accepts transfers that cover the price and rejects short payments", () => {
  assert.equal(coversExpectedAmount("5990000", 5.99), true);
  assert.equal(coversExpectedAmount("6000000", 5.99), true);
  assert.equal(coversExpectedAmount("49000000", 49), true);
  // A 0.01 USDT rounding shortfall is tolerated; a larger one is not.
  assert.equal(coversExpectedAmount("5980000", 5.99), true);
  assert.equal(coversExpectedAmount("5900000", 5.99), false);
  assert.equal(coversExpectedAmount("48000000", 49), false);
  assert.equal(coversExpectedAmount("0", 5.99), false);
});

test("ignores malformed transfer values instead of treating them as paid", () => {
  for (const bad of ["", null, undefined, "abc", "-5990000", "5.99", "1e7"]) {
    assert.equal(coversExpectedAmount(bad, 5.99), false, String(bad));
  }
});

test("handles amounts beyond double precision without drift", () => {
  const huge = "999999999999999999999";
  assert.equal(coversExpectedAmount(huge, 49), true);
});
