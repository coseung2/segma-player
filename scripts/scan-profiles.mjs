import { readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const roots = [
  "C:\\Users\\coseung2\\AppData\\Local\\Google\\Chrome\\User Data",
  "C:\\Users\\coseung2\\Desktop\\Projects\\aura\\.codex\\chrome-profile-nice-upload",
  "C:\\Users\\coseung2\\AppData\\Local\\Microsoft\\Edge\\User Data",
  "C:\\Users\\coseung2\\AppData\\Local\\Naver\\Naver Whale\\User Data",
  "C:\\Users\\coseung2\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
  "C:\\Users\\coseung2\\AppData\\Local\\Google\\Chrome SxS\\User Data",
  "C:\\Users\\coseung2\\AppData\\Local\\Chromium\\User Data",
  "C:\\Users\\coseung2\\AppData\\Roaming\\Opera Software\\Opera Stable",
  "C:\\Users\\coseung2\\AppData\\Local\\Vivaldi\\User Data",
];
const result = [];
for (const userData of roots) {
  if (!existsSync(userData)) continue;
  const discovered = readdirSync(userData, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Profile \d+$/.test(entry.name))
    .map((entry) => entry.name);
  const profiles = [...new Set(["Default", ...discovered])];
  for (const profile of profiles) {
    const dbPath = `${userData}\\${profile}\\Network\\Cookies`;
    if (!existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
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
        profile: `${userData.split("\\").slice(-2)[0]}\\${profile}`,
        nonEmpty: rows.length,
        hasSid: names.some((name) => ["SID", "__Secure-1PSID", "__Secure-3PSID"].includes(name)),
        hasLoginInfo: names.includes("LOGIN_INFO"),
        names: [...new Set(names)].slice(0, 25),
      });
    } catch (error) {
      result.push({ profile: `${userData.split("\\").slice(-2)[0]}\\${profile}`, error: error.message });
    }
  }
}
console.log(JSON.stringify(result, null, 1));
