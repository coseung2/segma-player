// DOM rendering for the companion UI.
//
// Views are rebuilt from the current state on every poll. All text goes through
// textContent so a filename or a host error message can never inject markup.

import {
  libraryItems,
  queueJobs,
  queueSummary,
  settingsView,
  subtitleJobs,
  subtitleSummary,
  toJobView,
} from "./model.js";

export const VIEWS = Object.freeze([
  { id: "queue", label: "Queue" },
  { id: "library", label: "Library" },
  { id: "player", label: "Player" },
  { id: "subtitles", label: "Subtitles" },
  { id: "settings", label: "Settings" },
]);

export const QUEUE_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "complete", label: "Complete" },
  { id: "failed", label: "Failed" },
]);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function chip(label, { tone = null, type = false } = {}) {
  const node = element("span", type ? "chip chip--type" : "chip", label);
  if (tone) node.dataset.tone = tone;
  return node;
}

function button(label, variant, { action = null, jobId = null, disabled = false } = {}) {
  const node = element("button", `button button--${variant}`, label);
  node.type = "button";
  if (action) node.dataset.action = action;
  if (jobId) node.dataset.jobId = jobId;
  node.disabled = disabled;
  return node;
}

function empty(message) {
  return element("p", "empty", message);
}

function progressBar(percent) {
  const track = element("div", "progress");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(percent));
  const fill = element("div", "progress-fill");
  fill.style.width = `${percent}%`;
  track.append(fill);
  return track;
}

export function renderRail(container, { activeView, status }) {
  container.replaceChildren();

  const brand = element("div", "brand");
  brand.append(element("p", "brand-name", "Aura Media"), element("p", "brand-role", "Companion"));
  container.append(brand);

  const nav = element("nav", "nav");
  nav.setAttribute("aria-label", "Companion sections");
  for (const view of VIEWS) {
    const item = element("button", "nav-item", view.label);
    item.type = "button";
    item.dataset.action = "navigate";
    item.dataset.view = view.id;
    if (view.id === activeView) item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  container.append(nav, element("div", "rail-spacer"));

  const connected = status?.ok === true;
  const link = element("div", "link-state");
  link.dataset.tone = connected ? "neutral" : "danger";
  link.append(
    element("p", "link-state-title", connected ? "Companion connected" : "Companion offline"),
    element(
      "p",
      "link-state-meta",
      connected
        ? `Protocol ${status.protocol ?? "?"} · ${status.version ?? "unknown build"}`
        : "Start Aura Media Companion, then reload.",
    ),
  );
  container.append(link);
}

function jobCard(view) {
  const card = element("li", "job-card");
  card.dataset.jobId = view.id;

  const head = element("div", "job-head");
  const identity = element("div", "job-identity");
  identity.append(element("h3", "job-title", view.title), chip(view.typeLabel, { type: true }));
  head.append(identity, chip(view.statusLabel, { tone: view.statusTone }));
  card.append(head);

  const detailParts = [];
  if (view.language) detailParts.push(view.language);
  if (view.detail) detailParts.push(view.detail);
  if (detailParts.length > 0) {
    card.append(element("p", "job-detail", detailParts.join(" · ")));
  }

  if (view.percent !== null) card.append(progressBar(view.percent));

  const foot = element("div", "job-foot");
  foot.append(element("p", "job-transfer", view.transfer ?? view.fileName ?? "—"));
  const actions = element("div", "job-actions");
  for (const action of view.actions) {
    if (action === "cancel") actions.append(button("Cancel", "quiet", { action: "cancel", jobId: view.id }));
    if (action === "reveal") actions.append(button("Open folder", "quiet", { action: "open-folder" }));
  }
  foot.append(actions);
  card.append(foot);
  return card;
}

function matchesQueueFilter(view, filter) {
  if (filter === "active") return view.active;
  if (filter === "complete") return view.statusTone === "success";
  if (filter === "failed") return view.statusTone === "danger";
  return true;
}

function header(title, summary, actions = []) {
  const wrapper = element("header", "view-header");
  const left = element("div");
  left.append(element("h2", "view-title", title));
  if (summary) left.append(element("p", "view-summary", summary));
  wrapper.append(left);
  if (actions.length > 0) {
    const right = element("div", "header-actions");
    right.append(...actions);
    wrapper.append(right);
  }
  return wrapper;
}

function segments(filters, activeId, action) {
  const group = element("div", "segments");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Filter");
  for (const filter of filters) {
    const node = element("button", "segment", filter.label);
    node.type = "button";
    node.dataset.action = action;
    node.dataset.filter = filter.id;
    node.setAttribute("aria-pressed", filter.id === activeId ? "true" : "false");
    group.append(node);
  }
  return group;
}

function renderQueue(container, state) {
  const views = queueJobs(state.jobs).map(toJobView);
  const filtered = views.filter((view) => matchesQueueFilter(view, state.queueFilter));

  container.append(
    header("Queue", queueSummary(state.jobs), [
      button("Refresh", "secondary", { action: "refresh" }),
      button("Open folder", "primary", { action: "open-folder" }),
    ]),
    segments(QUEUE_FILTERS, state.queueFilter, "queue-filter"),
  );

  const linkRow = element("div", "link-row");
  const input = element("input", "field field--inline");
  input.type = "url";
  input.id = "link-input";
  input.placeholder = "Paste a YouTube address";
  input.spellcheck = false;
  input.value = state.linkValue ?? "";
  const label = element("label", "visually-hidden", "YouTube address");
  label.htmlFor = "link-input";

  const quality = document.createElement("select");
  quality.id = "link-quality";
  quality.dataset.action = "quality";
  for (const option of state.qualities) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    if (option.value === state.quality) node.selected = true;
    quality.append(node);
  }
  const qualityLabel = element("label", "visually-hidden", "Quality");
  qualityLabel.htmlFor = "link-quality";

  linkRow.append(
    label,
    input,
    qualityLabel,
    quality,
    button(state.linkBusy ? "Starting…" : "Add link", "primary", {
      action: "add-link",
      disabled: state.linkBusy,
    }),
  );
  container.append(linkRow);

  if (state.linkMessage) {
    const message = element("p", "form-message", state.linkMessage.text);
    if (state.linkMessage.tone) message.dataset.tone = state.linkMessage.tone;
    container.append(message);
  }

  if (filtered.length === 0) {
    container.append(
      empty(
        views.length === 0
          ? "No download jobs yet. Send one from the browser extension, or paste a YouTube link above."
          : "No jobs match this filter.",
      ),
    );
    return;
  }

  const list = element("ul", "job-list");
  for (const view of filtered) list.append(jobCard(view));
  container.append(list);
}

function renderLibrary(container, state) {
  const query = (state.librarySearch ?? "").trim().toLowerCase();
  const items = libraryItems(state.jobs).filter((item) =>
    query === "" ? true : item.title.toLowerCase().includes(query) || item.fileName.toLowerCase().includes(query),
  );

  const search = element("input", "field field--search");
  search.type = "search";
  search.id = "library-search";
  search.placeholder = "Search library";
  search.value = state.librarySearch ?? "";
  const searchLabel = element("label", "visually-hidden", "Search library");
  searchLabel.htmlFor = "library-search";

  const wrapper = element("div");
  wrapper.append(searchLabel, search);

  const total = libraryItems(state.jobs).length;
  container.append(header("Library", total === 1 ? "1 saved item" : `${total} saved items`, [wrapper]));

  if (items.length === 0) {
    container.append(
      empty(
        total === 0
          ? "Completed downloads appear here once the companion finishes writing a file."
          : "Nothing matches that search.",
      ),
    );
    return;
  }

  const grid = element("ul", "tile-grid");
  for (const item of items) {
    const tile = element("li", "tile");
    const thumb = element("button", "tile-thumb", item.typeLabel);
    thumb.type = "button";
    thumb.dataset.action = "play";
    thumb.dataset.jobId = item.id;
    thumb.setAttribute("aria-label", `Open ${item.title} in the player`);
    const meta = [item.size, item.fileName].filter(Boolean).join(" · ");
    tile.append(thumb, element("h3", "tile-title", item.title), element("p", "tile-meta", meta));
    grid.append(tile);
  }
  container.append(grid);
}

function renderPlayer(container, state) {
  const selected = libraryItems(state.jobs).find((item) => item.id === state.selectedJobId) ?? null;

  container.append(
    header(
      selected ? selected.title : "Player",
      selected ? [selected.size, selected.fileName].filter(Boolean).join(" · ") : "Nothing selected",
      selected ? [button("Open folder", "secondary", { action: "open-folder" })] : [],
    ),
  );

  const stage = element("div", "stage");
  if (selected) {
    // The companion writes into its downloads folder and the protocol exposes no
    // file-read or stream command, so the WebView has no readable source yet.
    // The stage stays a placeholder instead of pointing at a path that cannot
    // load, which would surface as a silent black frame.
    stage.append(
      element(
        "p",
        "stage-empty",
        "Playback needs a companion media source. The current protocol has no file-read command, so this view is wired for layout only.",
      ),
    );
  } else {
    stage.append(element("p", "stage-empty", "Pick an item in Library to load it here."));
  }
  container.append(stage);

  if (selected) {
    const bar = element("div", "player-bar");
    const meta = element("div", "player-meta");
    meta.append(chip(selected.typeLabel, { type: true }), element("span", null, selected.size ?? "size unknown"));
    bar.append(meta, button("Back to library", "quiet", { action: "navigate", jobId: null }));
    const back = bar.querySelector('[data-action="navigate"]');
    back.dataset.view = "library";
    container.append(bar);
  }
}

function renderSubtitles(container, state) {
  const views = subtitleJobs(state.jobs).map(toJobView);

  container.append(
    header("Subtitles", subtitleSummary(state.jobs), [button("Refresh", "secondary", { action: "refresh" })]),
  );

  if (views.length === 0) {
    container.append(
      empty("Subtitle jobs start from the browser extension. Generated tracks and failures appear here."),
    );
    return;
  }

  const list = element("ul", "job-list");
  for (const view of views) list.append(jobCard(view));
  container.append(list);
}

function renderSettings(container, state) {
  const view = settingsView(state.status);
  container.append(
    header("Settings", view.connected ? "Reported by the companion" : "Companion not connected", [
      button("Refresh", "secondary", { action: "refresh" }),
    ]),
  );

  for (const group of view.groups) {
    const card = element("section", "setting-group");
    card.append(element("h3", "setting-caption", group.title));
    const rows = element("ul", "setting-rows");
    for (const row of group.rows) {
      const item = element("li", "setting-row");
      const left = element("div");
      left.append(element("p", "setting-title", row.title));
      const value = element("p", `setting-value${row.mono ? " setting-value--mono" : ""}`, row.value);
      left.append(value);
      item.append(left);
      if (row.control?.kind === "button") {
        item.append(button(row.control.label, "secondary", { action: row.control.action }));
      } else if (row.control?.kind === "status") {
        item.append(chip(row.control.label, { tone: row.control.tone }));
      }
      rows.append(item);
    }
    card.append(rows);
    container.append(card);
  }
}

const RENDERERS = {
  queue: renderQueue,
  library: renderLibrary,
  player: renderPlayer,
  subtitles: renderSubtitles,
  settings: renderSettings,
};

export function renderContent(container, state) {
  container.replaceChildren();

  if (state.error) {
    const banner = element("div", "banner");
    banner.setAttribute("role", "alert");
    banner.append(element("span", null, state.error), button("Retry", "secondary", { action: "refresh" }));
    container.append(banner);
  }

  const render = RENDERERS[state.view] ?? renderQueue;
  render(container, state);
}

export function render(root, state) {
  renderRail(root.rail, state);
  renderContent(root.content, state);
}
