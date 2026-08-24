// Companion UI controller: owns state, wires events, polls the host.

import { newJobId, normalizeQualities, validateLinkInput } from "./model.js";
import { render, VIEWS } from "./render.js";
import { createCompanionClient, createFixtureTransport, createWebView2Transport } from "./transport.js";

const POLL_INTERVAL_MS = 2000;
const VIEW_IDS = new Set(VIEWS.map((view) => view.id));

const state = {
  view: "queue",
  jobs: [],
  status: null,
  error: null,
  queueFilter: "all",
  librarySearch: "",
  selectedJobId: null,
  linkValue: "",
  linkBusy: false,
  linkMessage: null,
  quality: "1080",
  qualities: normalizeQualities(null),
};

const root = {
  rail: document.querySelector("#rail"),
  content: document.querySelector("#content"),
};

let client = null;
let polling = null;

function paint() {
  render(root, state);
}

function setError(error) {
  state.error = error instanceof Error ? error.message : error;
}

async function refresh({ quiet = false } = {}) {
  if (!client) return;
  try {
    const [status, jobs] = await Promise.all([client.status(), client.listJobs()]);
    state.status = status;
    state.jobs = jobs;
    state.error = null;
  } catch (error) {
    // A failed poll keeps the last good job list on screen; replacing it with an
    // empty state would make a transient disconnect look like lost history.
    if (!quiet) setError(error);
    if (state.status) state.status = { ...state.status, ok: false };
  }
  paint();
}

function focusPreserved(action) {
  const active = document.activeElement;
  const id = active?.id ?? null;
  const start = typeof active?.selectionStart === "number" ? active.selectionStart : null;
  action();
  if (!id) return;
  const restored = document.getElementById(id);
  if (!restored) return;
  restored.focus();
  if (start !== null && typeof restored.setSelectionRange === "function") {
    try {
      restored.setSelectionRange(start, start);
    } catch {
      /* selection is not supported on this input type */
    }
  }
}

async function submitLink() {
  const check = validateLinkInput(state.linkValue);
  if (!check.ok) {
    state.linkMessage = { text: check.reason, tone: "danger" };
    paint();
    return;
  }

  state.linkBusy = true;
  state.linkMessage = { text: "Reading the video…", tone: null };
  paint();

  try {
    const info = await client.youtubeInfo(check.url);
    state.qualities = normalizeQualities(info?.qualities);
    if (!state.qualities.some((option) => option.value === state.quality)) {
      state.quality = state.qualities[0]?.value ?? "1080";
    }
    const jobId = newJobId();
    await client.startYouTubeDownload({ jobId, url: check.url, quality: state.quality });
    state.linkValue = "";
    state.linkMessage = {
      text: `Sent to the companion${info?.title ? `: ${info.title}` : ""}.`,
      tone: null,
    };
  } catch (error) {
    state.linkMessage = { text: error instanceof Error ? error.message : String(error), tone: "danger" };
  } finally {
    state.linkBusy = false;
    await refresh({ quiet: true });
  }
}

async function handleAction(action, target) {
  switch (action) {
    case "navigate": {
      const view = target.dataset.view;
      if (VIEW_IDS.has(view)) {
        state.view = view;
        paint();
      }
      return;
    }
    case "queue-filter":
      state.queueFilter = target.dataset.filter ?? "all";
      paint();
      return;
    case "refresh":
      await refresh();
      return;
    case "cancel":
      try {
        await client.cancelJob(target.dataset.jobId);
      } catch (error) {
        setError(error);
      }
      await refresh({ quiet: true });
      return;
    case "open-folder":
      try {
        await client.openFolder();
      } catch (error) {
        setError(error);
        paint();
      }
      return;
    case "play":
      state.selectedJobId = target.dataset.jobId ?? null;
      state.view = "player";
      paint();
      return;
    case "add-link":
      await submitLink();
      return;
    default:
      return;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!target) return;
  const action = target.dataset.action;
  if (action === "quality") return;
  event.preventDefault();
  void handleAction(action, target);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "library-search") {
    state.librarySearch = target.value;
    focusPreserved(paint);
    return;
  }
  if (target.id === "link-input") {
    state.linkValue = target.value;
    if (state.linkMessage) {
      state.linkMessage = null;
      focusPreserved(paint);
    }
    return;
  }
  if (target.id === "link-quality") {
    state.quality = target.value;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const target = event.target;
  if (target instanceof Element && target.id === "link-input") {
    event.preventDefault();
    void submitLink();
  }
});

async function loadFixture() {
  const response = await fetch("./fixtures/jobs.json");
  if (!response.ok) throw new Error(`Fixture load failed: ${response.status}`);
  return response.json();
}

async function start() {
  const webview = globalThis.chrome?.webview;
  if (webview && typeof webview.postMessage === "function") {
    client = createCompanionClient(createWebView2Transport(webview));
  } else {
    // Browser preview mode. This keeps layout and state verification possible
    // before the Rust side hosts a WebView, and it is explicit in the UI.
    try {
      client = createCompanionClient(createFixtureTransport(await loadFixture()));
      state.error = "Preview mode: showing recorded fixture data, not a live companion.";
    } catch (error) {
      setError(error);
      paint();
      return;
    }
  }

  await refresh();
  polling = setInterval(() => void refresh({ quiet: true }), POLL_INTERVAL_MS);
}

window.addEventListener("beforeunload", () => {
  if (polling) clearInterval(polling);
});

void start();
