import { clearDownloadFolder, getDownloadFolder, setDownloadFolder } from "./folder-store.js";

const folderNameElement = document.querySelector("#folder-name");
const chooseButton = document.querySelector("#choose-folder");
const clearButton = document.querySelector("#clear-folder");
const statusElement = document.querySelector("#status");

async function refresh() {
  let handle = null;
  try { handle = await getDownloadFolder(); } catch { /* IndexedDB unavailable */ }
  folderNameElement.textContent = handle
    ? `지정됨: ${handle.name}`
    : "지정된 폴더 없음 — 다운로드할 때 저장 위치를 묻습니다.";
  clearButton.hidden = !handle;
}

chooseButton.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await setDownloadFolder(handle);
    statusElement.textContent = `저장 폴더를 지정했습니다: ${handle.name}`;
    await refresh();
  } catch (error) {
    if (error?.name === "AbortError") return;
    statusElement.textContent = "폴더를 지정하지 못했습니다.";
  }
});

clearButton.addEventListener("click", async () => {
  await clearDownloadFolder();
  statusElement.textContent = "저장 폴더 설정을 해제했습니다.";
  await refresh();
});

void refresh();
