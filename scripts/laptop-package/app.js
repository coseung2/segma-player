// Aura YouTube proxy service — yt-dlp + ffmpeg on the notebook.
// v2: HMAC capability tokens issued by the license worker, per-device quota,
// global daily cap, queue cap, disk guard, temp-file cleanup after delivery.
const http = require("http");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.AURA_YT_PORT || 8788);
const PROFILE = process.env.USERPROFILE || "C:\\Users\\coseung2";
const YT_DLP = process.env.AURA_YT_DLP || path.join(PROFILE, "AppData", "Local", "AuraDownloader", "youtube", "tools", "yt-dlp.exe");
const FFMPEG_LOCATION = process.env.AURA_YT_FFMPEG || path.join(PROFILE, "AppData", "Local", "AuraDownloader", "youtube", "tools", "ffmpeg");
const WORK_DIR = process.env.AURA_YT_WORK || path.join(PROFILE, "AppData", "Local", "Aura YouTube", "work");
const QUOTA_FILE = process.env.AURA_YT_QUOTA || path.join(PROFILE, "AppData", "Local", "Aura YouTube", "quota.json");
const COOKIES_FILE = process.env.AURA_YT_COOKIES || path.join(PROFILE, "AppData", "Local", "Aura YouTube", "cookies.txt");
const PRO_SECRET = process.env.AURA_YT_PRO_SECRET || "";
const YT_SECRET = process.env.AURA_YT_SECRET || "";
const MAX_CONCURRENT = Number(process.env.AURA_YT_MAX_CONCURRENT || 2);
const FREE_MONTHLY_LIMIT = Number(process.env.AURA_YT_FREE_LIMIT || 10);
const DAILY_CAP = Number(process.env.AURA_YT_DAILY_CAP || 500);
const MAX_QUEUE = Number(process.env.AURA_YT_MAX_QUEUE || 40);
const MIN_FREE_BYTES = Number(process.env.AURA_YT_MIN_FREE_GB || 2) * 1024 * 1024 * 1024;
const LOG_FILE = process.env.AURA_YT_LOG || path.join(PROFILE, "AppData", "Local", "Aura YouTube", "server.log");
const LOCAL_SAVE_DIR = process.env.AURA_YT_LOCAL_SAVE_DIR || "";
const JOB_TTL_MS = 60 * 60 * 1000;
// Accept "best" or any positive height (the popup offers heights detected by
// the live format probe, which are not limited to the old preset list).
function validQuality(value) {
  return value === "best" || /^[1-9]\d{1,4}$/.test(String(value));
}

// Shared token verification is loaded lazily from the same directory.
// Windows paths must be converted to file:// URLs for dynamic import.
let tokenModule = null;
const tokenModuleReady = import(pathToFileURL(path.join(__dirname, "youtube-token.js")).href)
  .then((module) => { tokenModule = module; })
  .catch((error) => {
    tokenModule = null;
    console.error("youtube-token module failed to load:", error && error.message);
  });

fs.mkdirSync(WORK_DIR, { recursive: true });

const jobs = new Map();
const queue = [];
const formatsCache = new Map();
const FORMATS_TTL_MS = 10 * 60 * 1000;
const FORMATS_CACHE_MAX = 200;
let active = 0;
let dailyKey = "";
let dailyUsed = 0;

function now() {
  return new Date().toISOString();
}

function logLine(message) {
  try {
    fs.appendFileSync(LOG_FILE, `${now()} ${message}\n`, "utf8");
  } catch {
    // Logging is best effort.
  }
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function loadQuota() {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveQuota(quota) {
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota));
}

function quotaStatus(deviceId, licenseKey) {
  if (PRO_SECRET && licenseKey && licenseKey === PRO_SECRET) {
    return { ok: true, pro: true, used: 0, limit: null };
  }
  const quota = loadQuota();
  const key = `${deviceId}:${monthKey()}`;
  const used = quota[key] || 0;
  return { ok: used < FREE_MONTHLY_LIMIT, pro: false, used, limit: FREE_MONTHLY_LIMIT };
}

function dailyStatus() {
  const key = new Date().toISOString().slice(0, 10);
  if (dailyKey !== key) {
    dailyKey = key;
    dailyUsed = 0;
  }
  return dailyUsed;
}

function diskFreeBytes() {
  try {
    if (typeof fs.statfsSync === "function") {
      const info = fs.statfsSync(WORK_DIR);
      return Number(info.bavail) * Number(info.bsize);
    }
  } catch {
    // Disk guard is best effort.
  }
  return Infinity;
}

async function authenticate(req) {
  await tokenModuleReady;
  if (!tokenModule || !YT_SECRET) return null;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  return tokenModule.verifyToken(YT_SECRET, token);
}

async function authenticateRequest(req, url) {
  const fromHeader = await authenticate(req);
  if (fromHeader) return fromHeader;
  const fromQuery = url.searchParams.get("t");
  if (!fromQuery) return null;
  await tokenModuleReady;
  if (!tokenModule || !YT_SECRET) return null;
  return tokenModule.verifyToken(YT_SECRET, fromQuery);
}

function reserveQuota(deviceId) {
  const quota = loadQuota();
  const key = `${deviceId}:${monthKey()}`;
  quota[key] = (quota[key] || 0) + 1;
  saveQuota(quota);
}

function refundQuota(deviceId) {
  const quota = loadQuota();
  const key = `${deviceId}:${monthKey()}`;
  if ((quota[key] || 0) > 0) {
    quota[key] -= 1;
    saveQuota(quota);
  }
}

function qualityFormat(quality) {
  if (quality === "best") return "bv*+ba/b";
  const height = Number(quality);
  if (Number.isFinite(height) && height > 0) {
    return `b[height<=${height}]/bv*[height<=${height}]+ba/b[height<=${height}]`;
  }
  return "b/bv*+ba";
}

function canonicalYouTubeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname === "youtu.be"
      || url.hostname === "youtube.com"
      || url.hostname.endsWith(".youtube.com")) return url.href;
  } catch {
    // invalid URL
  }
  return null;
}

function youtubeVideoId(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    const direct = url.searchParams.get("v");
    if (direct) return direct;
    const pathMatch = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/.exec(url.pathname);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

function runFormatsProbe(url) {
  return new Promise((resolve) => {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--dump-single-json",
      "--js-runtimes", `node:${process.execPath}`,
    ];
    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) args.push("--cookies", COOKIES_FILE);
    args.push(url);
    const child = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), 25_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 4_000_000) child.kill();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout);
        const heights = new Set();
        for (const format of data?.formats || []) {
          const height = Number(format?.height);
          if (Number.isFinite(height) && height > 0) heights.add(height);
        }
        const sorted = [...heights].sort((a, b) => b - a);
        const maxHeight = sorted[0] || 0;
        const qualities = sorted.filter((height) => height >= 360 || height === maxHeight);
        resolve(qualities.length ? qualities : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function rememberFormats(videoId, qualities) {
  if (formatsCache.size >= FORMATS_CACHE_MAX) {
    const oldest = [...formatsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) formatsCache.delete(oldest[0]);
  }
  formatsCache.set(videoId, { qualities, at: Date.now() });
}

function finishJob(job, filePath, error) {
  active = Math.max(0, active - 1);
  job.status = error ? "failed" : "ready";
  job.file = filePath;
  job.error = error || "";
  job.updatedAt = now();
  if (error) refundQuota(job.deviceId);
  drain();
}

function saveLocalCopy(job, filePath) {
  if (!filePath || !LOCAL_SAVE_DIR) return;
  try {
    fs.mkdirSync(LOCAL_SAVE_DIR, { recursive: true });
    const extension = path.extname(filePath) || ".mp4";
    const base = (job.title || "YouTube 영상")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.+$/, "").trim().slice(0, 150) || "YouTube 영상";
    const target = path.join(LOCAL_SAVE_DIR, `${base}${extension}`);
    fs.copyFileSync(filePath, target);
    job.localFile = target;
    logLine(`LOCAL_SAVE ${job.id} -> ${target}`);
  } catch (error) {
    logLine(`LOCAL_SAVE_FAIL ${job.id} ${error && error.message}`);
    job.localFile = null;
  }
}

function drain() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    runJob(job);
  }
}

function runJob(job) {
  active += 1;
  job.status = "processing";
  job.updatedAt = now();
  const outputBase = path.join(WORK_DIR, job.id);
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "--js-runtimes", `node:${process.execPath}`,
    "--merge-output-format", "mp4",
    "--print", "after_move:%(title)s",
    "-f", qualityFormat(job.quality),
    "-o", `${outputBase}.%(ext)s`,
    job.url,
  ];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    args.splice(args.length - 1, 0, "--cookies", COOKIES_FILE);
  }
  if (FFMPEG_LOCATION && fs.existsSync(FFMPEG_LOCATION)) {
    args.splice(args.length - 1, 0, "--ffmpeg-location", FFMPEG_LOCATION);
  }
  const child = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.startsWith("after_move:")) job.title = line.slice("after_move:".length).trim().slice(0, 200);
      const progressMatch = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (progressMatch) {
        const percent = Number(progressMatch[1]);
        if (Number.isFinite(percent)) job.progress = Math.max(0, Math.min(100, percent));
      }
      const speedMatch = /at\s+([\d.]+)([KMG]iB)\/s/.exec(line);
      if (speedMatch) {
        const value = Number(speedMatch[1]);
        const unit = speedMatch[2];
        const multiplier = unit === "KiB" ? 1024 : unit === "MiB" ? 1024 ** 2 : 1024 ** 3;
        if (Number.isFinite(value)) job.speedMBps = (value * multiplier) / (1024 ** 2);
      }
      const etaMatch = /ETA\s+(\d+)/.exec(line);
      if (etaMatch) {
        const eta = Number(etaMatch[1]);
        if (Number.isFinite(eta)) job.etaSeconds = eta;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on("error", (err) => finishJob(job, null, err.message));
  child.on("close", (code) => {
    if (code !== 0) {
      finishJob(job, null, stderr.trim() || `yt-dlp exit ${code}`);
      return;
    }
    let filePath = null;
    try {
      const file = fs.readdirSync(WORK_DIR).find((name) => name.startsWith(`${job.id}.`));
      if (file) filePath = path.join(WORK_DIR, file);
    } catch {
      // cleanup sweep
    }
    if (!filePath) {
      finishJob(job, null, "output-file-missing");
      return;
    }
    saveLocalCopy(job, filePath);
    finishJob(job, filePath, null);
  });
}

function cleanupJob(job) {
  if (job.file) {
    try {
      fs.unlinkSync(job.file);
    } catch {
      // already gone
    }
    job.file = null;
  }
  jobs.delete(job.id);
}

function streamFile(job, res) {
  fs.stat(job.file, (err, stat) => {
    if (err || !stat.isFile()) {
      cleanupJob(job);
      json(res, 404, { error: "file-gone" });
      return;
    }
    const name = path.basename(job.file);
    const headers = {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    };
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = res.req?.headers?.range;
    if (typeof range === "string" && range.trim()) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && (match[1] !== "" || match[2] !== "")) {
        const requestedStart = match[1] === "" ? null : Number(match[1]);
        const requestedEnd = match[2] === "" ? null : Number(match[2]);
        if ((requestedStart === null || Number.isFinite(requestedStart))
          && (requestedEnd === null || Number.isFinite(requestedEnd))) {
          start = requestedStart === null ? 0 : requestedStart;
          end = requestedEnd === null ? stat.size - 1 : Math.min(requestedEnd, stat.size - 1);
          if (start <= end && start < stat.size) {
            status = 206;
            headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
            headers["Content-Length"] = end - start + 1;
          }
        }
      }
    }
    if (status === 200) headers["Content-Length"] = stat.size;
    res.writeHead(status, headers);
    const stream = fs.createReadStream(job.file, { start, end });
    stream.pipe(res);
    // Remove the job only after a full (non-range) transfer was flushed.
    // Range probes (bytes=0-0) must leave the file for the real download;
    // aborted or partial transfers are cleaned up by the TTL sweep.
    res.on("finish", () => {
      if (status === 200) cleanupJob(job);
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function logRequest(req, status, extra = "") {
  const device = extra || "";
  logLine(`${req.method} ${req.url} -> ${status} ${device}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error("payload-too-large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname;
  try {
    if (req.method === "GET" && route === "/healthz") {
      json(res, 200, { ok: true, service: "aura-youtube", active, queued: queue.length });
      logRequest(req, 200, `active=${active} queued=${queue.length}`);
      return;
    }
    if (req.method === "GET" && /^\/api\/jobs\/[^/]+\/file$/.test(route)) {
      const payload = await authenticateRequest(req, url);
      if (!payload) {
        json(res, 401, { error: "unauthorized" });
        logRequest(req, 401);
        return;
      }
      const job = jobs.get(route.split("/")[3]);
      if (!job || job.deviceId !== payload.deviceId || job.status !== "ready" || !job.file) {
        json(res, 404, { error: "job-not-ready" });
        logRequest(req, 404, `job=${route.split("/")[3]}`);
        return;
      }
      streamFile(job, res);
      logRequest(req, 200, `job=${job.id} size=${fs.statSync(job.file).size}`);
      return;
    }
    if (req.method === "GET" && /^\/api\/jobs\/[^/]+$/.test(route)) {
      const payload = await authenticateRequest(req, url);
      if (!payload) {
        json(res, 401, { error: "unauthorized" });
        logRequest(req, 401);
        return;
      }
      const job = jobs.get(route.split("/")[3]);
      if (!job || job.deviceId !== payload.deviceId) {
        json(res, 404, { error: "job-not-found" });
        logRequest(req, 404, `job=${route.split("/")[3]}`);
        return;
      }
      json(res, 200, {
        id: job.id,
        status: job.status,
        title: job.title || "",
        error: job.error || "",
        progress: Number.isFinite(job.progress) ? job.progress : null,
        speedMBps: Number.isFinite(job.speedMBps) ? job.speedMBps : null,
        etaSeconds: Number.isFinite(job.etaSeconds) ? job.etaSeconds : null,
        localFile: typeof job.localFile === "string" ? job.localFile : null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
      logRequest(req, 200, `job=${job.id} status=${job.status}`);
      return;
    }
    if (req.method === "POST" && route === "/api/youtube") {
      const payload = await authenticate(req);
      if (!payload) {
        json(res, 401, { error: "unauthorized" });
        logRequest(req, 401);
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const { url: mediaUrl, quality = "best" } = body;
      const deviceId = payload.deviceId;
      const isPro = payload.plan === "pro";
      const canonical = canonicalYouTubeUrl(mediaUrl);
      if (!canonical) {
        json(res, 400, { error: "invalid-youtube-url" });
        logRequest(req, 400, `device=${deviceId}`);
        return;
      }
      if (!validQuality(String(quality))) {
        json(res, 400, { error: "invalid-quality" });
        logRequest(req, 400, `device=${deviceId} quality=${quality}`);
        return;
      }
      const status = isPro ? { ok: true, pro: true, used: 0, limit: null } : quotaStatus(deviceId, "");
      if (!status.ok) {
        json(res, 429, { error: "monthly-limit-reached", used: status.used, limit: status.limit });
        logRequest(req, 429, `device=${deviceId}`);
        return;
      }
      if (dailyStatus() >= DAILY_CAP) {
        json(res, 429, { error: "daily-limit-reached", used: dailyUsed, limit: DAILY_CAP });
        logRequest(req, 429, `device=${deviceId}`);
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        json(res, 429, { error: "server-busy" });
        logRequest(req, 429, `device=${deviceId}`);
        return;
      }
      if (diskFreeBytes() < MIN_FREE_BYTES) {
        json(res, 507, { error: "insufficient-storage" });
        logRequest(req, 507, `device=${deviceId}`);
        return;
      }
      reserveQuota(deviceId);
      dailyUsed += 1;
      const id = crypto.randomUUID();
      logLine(`JOB ${id} device=${deviceId} plan=${payload.plan} url=${canonical} quality=${quality}`);
      const job = {
        id,
        status: "queued",
        url: canonical,
        quality: String(quality),
        deviceId,
        title: "",
        createdAt: now(),
        updatedAt: now(),
        file: null,
        error: "",
      };
      const statusForResponse = isPro
        ? { pro: true, used: null, limit: null }
        : { pro: false, used: status.used + 1, limit: FREE_MONTHLY_LIMIT };
      jobs.set(id, job);
      queue.push(job);
      drain();
      json(res, 202, {
        jobId: id,
        status: "queued",
        quotaUsed: statusForResponse.used,
        quotaLimit: statusForResponse.limit,
        pro: statusForResponse.pro,
      });
      logRequest(req, 202, `job=${id} device=${deviceId} plan=${payload.plan}`);
      return;
    }
    if (req.method === "POST" && route === "/api/youtube-formats") {
      const payload = await authenticate(req);
      if (!payload) {
        json(res, 401, { error: "unauthorized" });
        logRequest(req, 401);
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      const canonical = canonicalYouTubeUrl(body?.url);
      if (!canonical) {
        json(res, 400, { error: "invalid-youtube-url" });
        logRequest(req, 400, `device=${payload.deviceId}`);
        return;
      }
      const videoId = youtubeVideoId(canonical);
      if (!videoId) {
        json(res, 400, { error: "invalid-youtube-url" });
        logRequest(req, 400, `device=${payload.deviceId}`);
        return;
      }
      const cached = formatsCache.get(videoId);
      if (cached && Date.now() - cached.at < FORMATS_TTL_MS) {
        json(res, 200, { ok: true, qualities: cached.qualities, cached: true });
        return;
      }
      const qualities = await runFormatsProbe(canonical);
      if (!qualities) {
        json(res, 502, { error: "formats-unavailable" });
        logRequest(req, 502, `device=${payload.deviceId} video=${videoId}`);
        return;
      }
      rememberFormats(videoId, qualities);
      json(res, 200, { ok: true, qualities });
      logRequest(req, 200, `device=${payload.deviceId} video=${videoId} q=${qualities.join(",")}`);
      return;
    }
    json(res, 404, { error: "not-found" });
    logRequest(req, 404);
  } catch (err) {
    json(res, 400, { error: err && err.message ? err.message : "bad-request" });
    logRequest(req, 400, `error=${err && err.message ? err.message : "bad-request"}`);
  }
});

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== "processing" && new Date(job.updatedAt).getTime() < cutoff) cleanupJob(job);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`aura-youtube listening on 0.0.0.0:${PORT}`);
});
