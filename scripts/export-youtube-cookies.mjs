import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";

const keyFile = process.argv[2] || `${process.env.TEMP}\\aura-cookie-key.txt`;
const dbPath = process.argv[3] || "C:\\Users\\coseung2\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies";
const outPath = process.argv[4] || "C:\\Users\\coseung2\\Desktop\\Projects\\aura-mdownloader\\artifacts\\youtube-cookies.txt";

const keyHex = readFileSync(keyFile, "utf8").trim();
const key = Buffer.from(keyHex, "hex");
if (key.length !== 32) throw new Error(`unexpected key length ${key.length}`);

const db = new DatabaseSync(dbPath, { readOnly: true });

function decryptValue(value) {
  const raw = Buffer.from(value, "base64");
  if (raw.length < 4 || raw[0] !== 0x76 || raw[1] !== 0x31 || raw[2] !== 0x30) return null;
  const nonce = raw.subarray(3, 15);
  const ciphertext = raw.subarray(15);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const rows = db.prepare(`
  SELECT host_key, path, is_secure, CAST(expires_utc AS TEXT) AS expires_utc, name, value
  FROM cookies
  WHERE host_key LIKE '%.youtube.com'
     OR host_key = 'youtube.com'
     OR host_key LIKE '%.google.com'
     OR host_key = 'google.com'
  ORDER BY host_key, name
`).all();

const lines = ["# Netscape HTTP Cookie File", "# Exported from Aura Media for the personal yt-dlp server", "# http://curl.haxx.se/rfc/cookie_spec.html"];
let exported = 0;
const names = new Set();
for (const row of rows) {
  const plain = decryptValue(row.value);
  if (plain === null || plain === "") continue;
  const secure = row.is_secure === 1 ? "TRUE" : "FALSE";
  const expiresMicros = BigInt(row.expires_utc);
  const expiry = expiresMicros > 0n
    ? Number(expiresMicros / 1000000n) - 11644473600
    : 0;
  lines.push(`${row.host_key}\tTRUE\t${row.path || "/"}\t${secure}\t${expiry}\t${row.name}\t${plain}`);
  exported += 1;
  names.add(row.name);
}

writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
const summary = {
  file: outPath,
  exported,
  hasSid: names.has("SID") || names.has("__Secure-1PSID") || names.has("__Secure-3PSID"),
  hasLoginInfo: names.has("LOGIN_INFO"),
  hasConsent: names.has("CONSENT"),
  names: [...names].sort().join(", "),
};
console.log(JSON.stringify(summary));
