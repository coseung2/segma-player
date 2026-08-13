import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const base = "C:\\Users\\coseung2\\AppData\\Local\\Google\\Chrome\\User Data";
const targets = ["Profile 2", "Profile 12"];
const result = [];

for (const profile of targets) {
  const sourceDir = `${base}\\${profile}\\Network`;
  const copyDir = `${process.env.TEMP}\\aura-cookie-copy-${profile.replaceAll(" ", "")}`;
  mkdirSync(copyDir, { recursive: true });
  for (const suffix of ["Cookies", "Cookies-wal", "Cookies-shm"]) {
    const src = `${sourceDir}\\${suffix}`;
    if (existsSync(src)) {
      try { copyFileSync(src, `${copyDir}\\${suffix}`); } catch (error) {
        result.push({ profile, copyError: `${suffix}: ${error.message}` });
      }
    }
  }
  try {
    const db = new DatabaseSync(`${copyDir}\\Cookies`, { readOnly: true });
    const rows = db.prepare(`
      SELECT host_key, name, length(value) AS len
      FROM cookies
      WHERE (host_key LIKE '%.youtube.com' OR host_key = 'youtube.com'
          OR host_key LIKE '%.google.com' OR host_key = 'google.com')
        AND length(value) > 0
      ORDER BY host_key, name
    `).all();
    const names = rows.map((row) => row.name);
    result.push({
      profile,
      nonEmpty: rows.length,
      hasSid: names.some((name) => ["SID", "__Secure-1PSID", "__Secure-3PSID"].includes(name)),
      hasLoginInfo: names.includes("LOGIN_INFO"),
      names: [...new Set(names)].slice(0, 30),
    });
  } catch (error) {
    result.push({ profile, error: error.message });
  }
}
console.log(JSON.stringify(result, null, 1));
