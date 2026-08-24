// Transport between the companion UI and the native host.
//
// The Rust companion does not host a WebView yet, so this module keeps the
// request surface behind one interface with two implementations:
//
//   webview2Transport  expects `window.chrome.webview` and forwards the same
//                      JSON request/reply envelope the native messaging port
//                      already uses. This is the shape the Rust side needs to
//                      bridge, and nothing else in the UI has to change.
//   fixtureTransport   replays a recorded payload so the UI can be opened in a
//                      plain browser for layout and state verification.
//
// Request names below are exactly the kinds `run_native_host` matches on:
// status, list-jobs, cancel-job, open-folder, youtube-info, youtube-download.

export const REQUEST_TIMEOUT_MS = 15000;

export class TransportError extends Error {
  constructor(message, code = "transport-failed") {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

function nextId(counter) {
  counter.value += 1;
  return `ui-${counter.value}`;
}

export function createWebView2Transport(webview, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!webview || typeof webview.postMessage !== "function") {
    throw new TransportError("This build has no companion WebView bridge.", "bridge-missing");
  }

  const pending = new Map();
  const counter = { value: 0 };

  webview.addEventListener("message", (event) => {
    const message = typeof event?.data === "string" ? safeParse(event.data) : event?.data;
    const requestId = message?.requestId;
    if (typeof requestId !== "string") return;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });

  return {
    kind: "webview2",
    request(type, payload = {}) {
      const requestId = nextId(counter);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new TransportError(`The companion did not answer ${type} in time.`, "timeout"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          webview.postMessage(JSON.stringify({ ...payload, type, requestId }));
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(new TransportError(error?.message ?? "Could not reach the companion.", "post-failed"));
        }
      });
    },
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Fixture transport. `state` is mutated in place so cancel and download show
 * real state transitions instead of a frozen snapshot.
 */
export function createFixtureTransport(fixture, { now = () => Date.now() } = {}) {
  const state = {
    status: { ...(fixture?.status ?? {}) },
    jobs: Array.isArray(fixture?.jobs) ? fixture.jobs.map((job) => ({ ...job })) : [],
    youtubeInfo: fixture?.youtubeInfo ?? null,
  };

  return {
    kind: "fixture",
    state,
    async request(type, payload = {}) {
      switch (type) {
        case "status":
          return { ok: true, ...state.status };
        case "list-jobs":
          return { ok: true, jobs: state.jobs.map((job) => ({ ...job })) };
        case "cancel-job": {
          const job = state.jobs.find((entry) => entry.jobId === payload.jobId);
          if (!job) return { ok: false, error: "That job is no longer in the list." };
          job.status = "cancelled";
          job.statusText = "Cancelled from the companion.";
          job.updatedAt = now();
          return { ok: true, jobId: payload.jobId };
        }
        case "open-folder":
          return { ok: true };
        case "youtube-info":
          return state.youtubeInfo
            ? { ok: true, ...state.youtubeInfo }
            : { ok: false, error: "Could not read that video.", errorCode: "youtube-info-failed" };
        case "youtube-download": {
          state.jobs.unshift({
            jobId: payload.jobId,
            status: "queued",
            statusText: "Waiting for the companion.",
            title: state.youtubeInfo?.title ?? "New download",
            inputKind: "mp4",
            progress: 0,
            createdAt: now(),
            updatedAt: now(),
          });
          return { ok: true, accepted: true, jobId: payload.jobId };
        }
        default:
          return { ok: false, errorCode: "unsupported-request", error: `Unsupported request: ${type}` };
      }
    },
  };
}

/**
 * Thin typed wrapper so views never hand-write request names, and so a failed
 * reply becomes a thrown TransportError with the host's own message.
 */
export function createCompanionClient(transport) {
  async function call(type, payload) {
    const reply = await transport.request(type, payload);
    if (reply?.ok !== true) {
      throw new TransportError(
        typeof reply?.error === "string" && reply.error !== ""
          ? reply.error
          : `The companion rejected ${type}.`,
        typeof reply?.errorCode === "string" ? reply.errorCode : "request-rejected",
      );
    }
    return reply;
  }

  return {
    kind: transport.kind,
    status: () => call("status"),
    listJobs: async () => {
      const reply = await call("list-jobs");
      return Array.isArray(reply.jobs) ? reply.jobs : [];
    },
    cancelJob: (jobId) => call("cancel-job", { jobId }),
    openFolder: () => call("open-folder"),
    youtubeInfo: (url) => call("youtube-info", { url }),
    startYouTubeDownload: ({ jobId, url, quality }) =>
      call("youtube-download", { jobId, url, quality }),
  };
}

export function detectTransport({ globalObject = globalThis, fixture = null } = {}) {
  const webview = globalObject?.chrome?.webview;
  if (webview && typeof webview.postMessage === "function") {
    return createWebView2Transport(webview);
  }
  if (fixture) return createFixtureTransport(fixture);
  throw new TransportError("No companion bridge and no fixture available.", "bridge-missing");
}
