import test from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_TTL_MS,
  isValidDeviceId,
  signToken,
  verifyToken,
} from "./youtube-token.js";

const SECRET = "test-secret-0123456789abcdef";

test("signs and verifies a free token round trip", async () => {
  const payload = { deviceId: "device-1234", plan: "free", keyId: null, exp: Date.now() + TOKEN_TTL_MS };
  const token = await signToken(SECRET, payload);
  const verified = await verifyToken(SECRET, token);
  assert.ok(verified);
  assert.equal(verified.deviceId, "device-1234");
  assert.equal(verified.plan, "free");
  assert.equal(verified.keyId, null);
  assert.equal(verified.v, 1);
});

test("signs and verifies a pro token with key id", async () => {
  const payload = { deviceId: "device-5678", plan: "pro", keyId: "AM-ABC", exp: Date.now() + TOKEN_TTL_MS };
  const token = await signToken(SECRET, payload);
  const verified = await verifyToken(SECRET, token);
  assert.equal(verified.plan, "pro");
  assert.equal(verified.keyId, "AM-ABC");
});

test("rejects tampered payloads and signatures", async () => {
  const token = await signToken(SECRET, { deviceId: "device-1234", plan: "free", exp: Date.now() + TOKEN_TTL_MS });
  const [encoded] = token.split(".");
  const tampered = `${encoded.slice(0, -2)}zz.${token.split(".")[1]}`;
  assert.equal(await verifyToken(SECRET, tampered), null);
  assert.equal(await verifyToken(SECRET, `${encoded}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), null);
});

test("rejects expired tokens and wrong secrets", async () => {
  const token = await signToken(SECRET, { deviceId: "device-1234", plan: "free", exp: Date.now() - 1 });
  assert.equal(await verifyToken(SECRET, token), null);
  const fresh = await signToken(SECRET, { deviceId: "device-1234", plan: "free", exp: Date.now() + TOKEN_TTL_MS });
  assert.equal(await verifyToken("another-secret-0123456789", fresh), null);
});

test("rejects malformed tokens and bad payload fields", async () => {
  assert.equal(await verifyToken(SECRET, "not-a-token"), null);
  assert.equal(await verifyToken(SECRET, ""), null);
  assert.equal(await verifyToken("", "x.y"), null);
  assert.equal(await verifyToken(SECRET, "%%%.%%%"), null);
  const shortDevice = await signToken(SECRET, { deviceId: "short", plan: "free", exp: Date.now() + 1000 });
  assert.equal(await verifyToken(SECRET, shortDevice), null);
  const badPlan = await signToken(SECRET, { deviceId: "device-1234", plan: "admin", exp: Date.now() + 1000 });
  assert.equal(await verifyToken(SECRET, badPlan), null);
});

test("requires a sufficiently long signing secret", async () => {
  await assert.rejects(signToken("short", { deviceId: "device-1234", plan: "free" }), /missing-secret/);
  await assert.rejects(signToken("", { deviceId: "device-1234", plan: "free" }), /missing-secret/);
});

test("validates device id shape", () => {
  assert.equal(isValidDeviceId("00000000-0000-4000-8000-000000000000"), true);
  assert.equal(isValidDeviceId("device-1234"), true);
  assert.equal(isValidDeviceId("short"), false);
  assert.equal(isValidDeviceId("x".repeat(65)), false);
  assert.equal(isValidDeviceId("bad device"), false);
  assert.equal(isValidDeviceId(""), false);
  assert.equal(isValidDeviceId(42), false);
  assert.equal(isValidDeviceId(null), false);
});
