import { DatabaseSync } from "node:sqlite";

const dbPath = "C:\\Users\\coseung2\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies";
const db = new DatabaseSync(dbPath, { readOnly: true });
const total = db.prepare("SELECT COUNT(*) AS c FROM cookies").get();
const hosts = db.prepare("SELECT host_key, COUNT(*) AS c FROM cookies GROUP BY host_key ORDER BY c DESC LIMIT 20").all();
const yt = db.prepare("SELECT COUNT(*) AS c FROM cookies WHERE host_key LIKE '%.youtube.com' OR host_key = 'youtube.com' OR host_key LIKE '%.google.com' OR host_key = 'google.com'").get();
const sample = db.prepare("SELECT host_key, name, length(value) AS len FROM cookies WHERE host_key LIKE '%.youtube.com' OR host_key = 'youtube.com' LIMIT 5").all();
console.log(JSON.stringify({ total, yt, hosts, sample }, null, 1));
