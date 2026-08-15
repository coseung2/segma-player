// Tron addresses appear in two forms: the base58check form users copy from a
// wallet (`T...`) and the 41-prefixed hex form TronGrid returns in event
// results (sometimes with a `0x` prefix and without the `41` network byte).
// Payment verification must compare a single normalized form, so everything is
// converted to lowercase 40-hex-character body without prefixes.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ToHex(value) {
  let numeric = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) return null;
    numeric = numeric * 58n + BigInt(index);
  }
  let hex = numeric.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  // base58check keeps a 4-byte checksum suffix that is not part of the address.
  return hex.length > 8 ? hex.slice(0, hex.length - 8) : null;
}

// Returns the 40-character hex body of a Tron address, or null when the input
// is not a recognizable address. Accepts `T...` base58, `41...` hex, `0x41...`,
// and the bare 40-character body TronGrid uses in `result.to`.
export function normalizeTronAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("T")) {
    const decoded = base58ToHex(raw);
    if (!decoded) return null;
    const lower = decoded.toLowerCase();
    if (!/^41[0-9a-f]{40}$/.test(lower)) return null;
    return lower.slice(2);
  }

  const hex = raw.replace(/^0x/i, "").toLowerCase();
  if (/^41[0-9a-f]{40}$/.test(hex)) return hex.slice(2);
  if (/^[0-9a-f]{40}$/.test(hex)) return hex;
  return null;
}

export function sameTronAddress(left, right) {
  const a = normalizeTronAddress(left);
  const b = normalizeTronAddress(right);
  return Boolean(a) && a === b;
}

// USDT-TRC20 uses 6 decimals. Comparing integer micro-units avoids the binary
// floating-point drift that would otherwise decide a payment by a rounding bit.
export function usdtMicroUnits(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 1e6);
}

// A transfer counts as paid when it covers the expected amount. Only a 0.01
// USDT shortfall is tolerated, which covers wallet rounding without accepting a
// materially smaller payment.
export function coversExpectedAmount(rawValue, expectedAmount, toleranceUsdt = 0.01) {
  const paid = (() => {
    const text = String(rawValue ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    try {
      return BigInt(text);
    } catch {
      return null;
    }
  })();
  if (paid === null) return false;
  const expected = usdtMicroUnits(expectedAmount);
  const tolerance = usdtMicroUnits(toleranceUsdt);
  if (expected === null || tolerance === null) return false;
  const minimum = BigInt(Math.max(0, expected - tolerance));
  return paid >= minimum;
}
