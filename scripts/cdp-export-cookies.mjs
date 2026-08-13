import { writeFileSync } from "node:fs";

const CDP_BASE = process.env.CDP_BASE || "http://127.0.0.1:9222";
const OUT = process.argv[2] || "C:\\Users\\coseung2\\Desktop\\Projects\\aura-mdownloader\\artifacts\\youtube-cookies.txt";

let nextId = 1;
function pending() {
  const id = nextId;
  nextId += 1;
  return { id, promise: null, resolve: null, reject: null };
}

const callbacks = new Map();

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = callbacks.get(message.id);
    if (!entry) return;
    callbacks.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const entry = pending();
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise = promise;
    callbacks.set(entry.id, entry);
    ws.send(JSON.stringify({ id: entry.id, method, params }));
    return promise;
  };
  return { ws, send };
}

async function main() {
  const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const target = list.find((item) => item.type === "page" && /youtube|newtab/i.test(item.url))
    || list.find((item) => item.type === "page");
  if (!target) throw new Error("no page target");
  const { ws, send } = await connect(target.webSocketDebuggerUrl);
  try {
    await send("Network.enable");
    const { cookies } = await send("Network.getAllCookies");
    const relevant = cookies.filter((cookie) => {
      const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
      return host === "youtube.com" || host.endsWith(".youtube.com")
        || host === "google.com" || host.endsWith(".google.com");
    });
    const lines = [
      "# Netscape HTTP Cookie File",
      "# Exported via Chrome DevTools Protocol (Aura Media yt-dlp server)",
    ];
    let exported = 0;
    const names = new Set();
    for (const cookie of relevant) {
      if (!cookie.value) continue;
      const domain = cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`;
      const secure = cookie.secure ? "TRUE" : "FALSE";
      const expiry = Number.isFinite(cookie.expires) && cookie.expires > 0
        ? Math.floor(cookie.expires)
        : 0;
      lines.push(`${domain}\tTRUE\t${cookie.path || "/"}\t${secure}\t${expiry}\t${cookie.name}\t${cookie.value}`);
      exported += 1;
      names.add(cookie.name);
    }
    writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
    const summary = {
      file: OUT,
      exported,
      hasSid: names.has("SID") || names.has("__Secure-1PSID") || names.has("__Secure-3PSID"),
      hasLoginInfo: names.has("LOGIN_INFO"),
      names: [...names].sort().join(", "),
    };
    console.log(JSON.stringify(summary));
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(`CDP_EXPORT_FAIL ${error.message}`);
  process.exit(1);
});
