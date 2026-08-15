import Hls from "./vendor/hls.min.mjs";
import { cuesAt, parseSrt } from "./player-subtitle.js";
import { addToCollection } from "./collection.js";

const params = new URLSearchParams(location.search);
const mediaUrl = params.get("url") || "";
const title = params.get("title") || "";
const subtitleSession = params.get("sub") || "";
const proActive = params.get("pro") === "1";

const video = document.getElementById("video");
const titleElement = document.getElementById("title");
const subtitleElement = document.getElementById("subtitle");
const subtitleTag = document.getElementById("subtitle-tag");
const message = document.getElementById("message");
const saveButton = document.getElementById("save");
if (!proActive) saveButton.hidden = true;

function fail(text) {
  message.hidden = false;
  message.textContent = text;
}

function cleanupSessions() {
  chrome.storage.local.get(null, (all) => {
    const now = Date.now();
    const stale = Object.keys(all || {}).filter(
      (key) => key.startsWith("auraSubtitleSession:") && now - (all[key]?.at || 0) > 10 * 60 * 1000,
    );
    if (stale.length) chrome.storage.local.remove(stale);
  });
}

async function loadSubtitles() {
  if (!subtitleSession) return;
  try {
    const stored = await chrome.storage.local.get(`auraSubtitleSession:${subtitleSession}`);
    const session = stored[`auraSubtitleSession:${subtitleSession}`];
    await chrome.storage.local.remove(`auraSubtitleSession:${subtitleSession}`);
    if (!session?.text) return;
    const cues = parseSrt(session.text);
    if (!cues.length) return;
    subtitleTag.hidden = false;
    video.addEventListener("timeupdate", () => {
      const cue = cuesAt(cues, video.currentTime);
      subtitleElement.hidden = !cue;
      subtitleElement.textContent = cue?.text || "";
    });
    video.addEventListener("seeking", () => {
      const cue = cuesAt(cues, video.currentTime);
      subtitleElement.hidden = !cue;
      subtitleElement.textContent = cue?.text || "";
    });
  } catch {
    // Subtitle overlay is best-effort; playback continues without it.
  }
}

function startPlayback() {
  if (!mediaUrl) {
    fail("재생할 주소가 없습니다.");
    return;
  }
  if (title) titleElement.textContent = title;

  const hlsCandidate = /\.m3u8(\?|#|$)/i.test(mediaUrl) || mediaUrl.includes(".m3u8");
  if (hlsCandidate && Hls.isSupported()) {
    const hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        fail("재생에 실패했습니다. 주소가 만료되었거나 지원하지 않는 스트림입니다.");
      }
    });
    hls.loadSource(mediaUrl);
    hls.attachMedia(video);
  } else if (hlsCandidate) {
    fail("이 브라우저는 HLS 재생을 지원하지 않습니다.");
  } else {
    video.src = mediaUrl;
  }
}

saveButton.addEventListener("click", async () => {
  await addToCollection({ title, url: mediaUrl });
  saveButton.textContent = "저장됨";
  saveButton.disabled = true;
});

cleanupSessions();
loadSubtitles().then(startPlayback);
