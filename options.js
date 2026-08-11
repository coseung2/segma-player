import { clearDownloadFolder, getDownloadFolder, setDownloadFolder } from "./folder-store.js";
import { FILTER_CATEGORIES } from "./adblock/adblock-rules.js";

const folderNameElement = document.querySelector("#folder-name");
const chooseButton = document.querySelector("#choose-folder");
const clearButton = document.querySelector("#clear-folder");
const statusElement = document.querySelector("#status");
const adblockEnabledButton = document.querySelector("#adblock-enabled");
const filterListElement = document.querySelector("#filter-list");
const allowListElement = document.querySelector("#allow-list");
const adblockStatusElement = document.querySelector("#adblock-status");

let adblockSettings = null;

function filterCheckbox(key, checked) {
  const category = FILTER_CATEGORIES[key];
  const row = document.createElement("label");
  row.className = "filter-row";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.dataset.filter = key;
  const body = document.createElement("span");
  const title = document.createElement("span");
  title.textContent = category.label;
  const description = document.createElement("p");
  description.textContent = category.description;
  body.append(title, description);
  row.append(input, body);
  return row;
}

function allowRow(site) {
  const row = document.createElement("li");
  const name = document.createElement("span");
  name.textContent = site;
  const remove = document.createElement("button");
  remove.className = "ghost";
  remove.type = "button";
  remove.textContent = "허용 해제";
  remove.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "adblock:set-site-allowed", site, allowed: false });
    await refreshAdBlock();
  });
  row.append(name, remove);
  return row;
}

async function refreshAdBlock() {
  const response = await chrome.runtime.sendMessage({ type: "adblock:get-state" });
  if (!response?.ok) throw new Error("adblock-state-unavailable");
  adblockSettings = response.settings;
  adblockEnabledButton.textContent = adblockSettings.enabled ? "사용 중 · 끄기" : "꺼짐 · 켜기";
  filterListElement.replaceChildren(
    ...Object.keys(FILTER_CATEGORIES).map((key) =>
      filterCheckbox(key, adblockSettings.filters[key]),
    ),
  );
  allowListElement.replaceChildren(
    ...(adblockSettings.siteAllow.length
      ? adblockSettings.siteAllow.map(allowRow)
      : [Object.assign(document.createElement("li"), { textContent: "허용한 사이트가 없습니다." })]),
  );
}

adblockEnabledButton.addEventListener("click", async () => {
  if (!adblockSettings) return;
  const response = await chrome.runtime.sendMessage({
    type: "adblock:set-enabled",
    enabled: !adblockSettings.enabled,
  });
  if (response?.ok) {
    adblockStatusElement.textContent = response.settings.enabled
      ? "광고 차단을 켰습니다."
      : "광고 차단을 껐습니다.";
  }
  await refreshAdBlock();
});

filterListElement.addEventListener("change", async (event) => {
  const key = event.target?.dataset?.filter;
  if (!key || !FILTER_CATEGORIES[key]) return;
  const response = await chrome.runtime.sendMessage({
    type: "adblock:set-filters",
    filters: { [key]: event.target.checked },
  });
  if (response?.ok) {
    adblockStatusElement.textContent = "필터 설정을 저장했습니다.";
  }
  await refreshAdBlock();
});

async function refresh() {
  let handle = null;
  try { handle = await getDownloadFolder(); } catch { /* IndexedDB unavailable */ }
  folderNameElement.textContent = handle
    ? `지정됨: ${handle.name}`
    : "지정된 폴더 없음 — 기본 Downloads\\Aura Media에 저장합니다.";
  clearButton.hidden = !handle;
}

chooseButton.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({
      id: "aura-media-downloads",
      mode: "readwrite",
      startIn: "downloads",
    });
    await setDownloadFolder(handle);
    statusElement.textContent = `저장 폴더를 지정했습니다: ${handle.name}`;
    await refresh();
  } catch (error) {
    if (error?.name === "AbortError") return;
    statusElement.textContent = error?.name === "SecurityError"
      ? "Chrome이 이 폴더를 보호 경로로 차단했습니다. 폴더를 지정하지 않아도 Downloads\\Aura Media에 저장됩니다."
      : "폴더를 지정하지 않았습니다. 기본 Downloads\\Aura Media에 저장됩니다.";
  }
});

clearButton.addEventListener("click", async () => {
  await clearDownloadFolder();
  statusElement.textContent = "저장 폴더 설정을 해제했습니다.";
  await refresh();
});

void refresh();
void refreshAdBlock().catch(() => {
  adblockStatusElement.textContent = "광고 차단 설정을 불러오지 못했습니다.";
});
