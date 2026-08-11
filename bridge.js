import { LIMITS, canonicalHttpUrl, redactCandidateForUi, redactUrl } from "./candidate.js";

export const BRIDGE_VERSION = 1;
export const BRIDGE_EXTENSION_ID = "hfpkpbadllkhedocoglbggkpnbaibmcp";
// This is an app/extension pairing context, not a VPN or enrollment secret.
// It only binds the already restricted native-messaging channel to this build.
export const BRIDGE_CONTEXT = `personal-vpn-bridge-context-v1-${BRIDGE_EXTENSION_ID}`;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_REPLAY_NONCES = 256;

function secureNonce() {
  if (!globalThis.crypto?.randomUUID) throw new Error("secure random nonce is unavailable");
  return `${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`;
}

function validString(value, max = 4096, allowWhitespace = false) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) && (allowWhitespace || !/\s/.test(value));
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function makeBase(kind, payload, now, sequence, auth = null) {
  return {
    version: BRIDGE_VERSION,
    kind,
    requestId: globalThis.crypto.randomUUID(),
    nonce: secureNonce(),
    sequence,
    sentAtMs: now,
    auth,
    payload,
  };
}

export function validateCandidatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (typeof payload.pageTitle !== "string" || [...payload.pageTitle].length > LIMITS.titleCharacters
    || /[\u0000-\u001f\u007f]/.test(payload.pageTitle)) return false;
  const page = canonicalHttpUrl(payload.pageOrigin);
  if (!page || `${page.protocol}//${page.host}` !== payload.pageOrigin) return false;
  if (!validResourceProjection(payload)) return false;
  if (!["PROGRESSIVE", "HLS_MASTER", "HLS_MEDIA", "DASH", "UNKNOWN"].includes(payload.mediaType)) return false;
  if (!Array.isArray(payload.variants) || payload.variants.length > LIMITS.variants) return false;
  return payload.variants.every(validResourceProjection);
}

function validResourceProjection(payload) {
  const url = canonicalHttpUrl(payload.resourceUrl);
  return Boolean(url && validString(payload.displayUrl, LIMITS.urlBytes, true)
    && payload.displayUrl === redactUrl(payload.resourceUrl));
}

export class BridgeClientSession {
  constructor({ expectedSecret, sessionId, expiresAtMs }) {
    if (!validString(expectedSecret, 1024) || expectedSecret.length < 32
      || !validString(sessionId, 128) || !Number.isSafeInteger(expiresAtMs)) {
      throw new Error("invalid bridge session configuration");
    }
    this.expectedSecret = expectedSecret;
    this.sessionId = sessionId;
    this.challenge = null;
    this.expiresAtMs = expiresAtMs;
    this.helloRequestId = null;
    this.authenticated = false;
    this.nextSequence = 0;
    this.seenNonces = new Set();
  }

  beginHello(now = Date.now()) {
    const message = makeBase("hello", {
      sessionId: this.sessionId,
      extensionId: BRIDGE_EXTENSION_ID,
    }, now, 0, null);
    this.helloRequestId = message.requestId;
    return message;
  }

  acceptAck(message, now = Date.now()) {
    const hostChallenge = message?.payload?.challenge;
    if (this.authenticated || !this.helloRequestId || !validString(hostChallenge, 256)
      || !this.#validateCommon(message, now, hostChallenge)
      || message.kind !== "hello_ack" || message.sequence !== 0
      || message.inReplyTo !== this.helloRequestId) return false;
    this.challenge = hostChallenge;
    this.authenticated = true;
    this.nextSequence = 1;
    this.#recordNonce(message.nonce);
    return true;
  }

  candidateEnvelope(candidate, now = Date.now()) {
    if (!this.authenticated || !this.challenge || now > this.expiresAtMs
      || !validateCandidatePayload(candidate)) {
      throw new Error("bridge session is not authenticated");
    }
    const message = makeBase("candidate", candidate, now, this.nextSequence, this.#auth());
    if (byteLength(message) > MAX_MESSAGE_BYTES) throw new Error("bridge message is too large");
    this.nextSequence += 1;
    return message;
  }

  #validateCommon(message, now, challenge) {
    if (!message || typeof message !== "object" || byteLength(message) > MAX_MESSAGE_BYTES
      || message.version !== BRIDGE_VERSION || !validString(message.requestId, 128)
      || !validString(message.nonce, 256) || message.nonce.length < 16
      || this.seenNonces.has(message.nonce) || !Number.isSafeInteger(message.sentAtMs)
      || Math.abs(message.sentAtMs - now) > MAX_CLOCK_SKEW_MS || message.sentAtMs > this.expiresAtMs
      || message.auth?.sessionId !== this.sessionId || message.auth?.challenge !== challenge
      || !constantTimeEqual(message.auth?.sessionToken, this.expectedSecret)) return false;
    return true;
  }

  #recordNonce(nonce) {
    this.seenNonces.add(nonce);
    while (this.seenNonces.size > MAX_REPLAY_NONCES) {
      this.seenNonces.delete(this.seenNonces.values().next().value);
    }
  }

  #auth() {
    return {
      sessionId: this.sessionId,
      challenge: this.challenge,
      sessionToken: this.expectedSecret,
    };
  }
}

export function redactEnvelopeForLog(message) {
  const payload = message?.kind === "candidate" ? redactCandidateForUi(message.payload) : undefined;
  return {
    version: message?.version,
    kind: message?.kind,
    requestId: message?.requestId,
    sequence: message?.sequence,
    sentAtMs: message?.sentAtMs,
    payload,
  };
}
