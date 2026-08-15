import { buildAuraPlayerUri, playableMediaUrl } from "./potplayer-protocol.js";

const candidates = document.getElementById("candidates");

function enhanceCandidateCard(card) {
  if (!(card instanceof HTMLElement) || card.dataset.auraPlayerEnhanced === "true") return;
  card.dataset.auraPlayerEnhanced = "true";

  const urlText = card.querySelector(".candidate-url")?.textContent || "";
  const mediaUrl = playableMediaUrl(urlText);
  if (!mediaUrl) return;

  const meta = card.querySelector(".candidate-meta");
  if (!meta) return;

  const title = card.querySelector(".candidate-title")?.textContent || "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button potplayer-button";
  button.textContent = "▶ PotPlayer";
  button.title = "PotPlayer에서 스트리밍 재생";
  button.setAttribute("aria-label", "PotPlayer에서 스트리밍 재생");
  button.addEventListener("click", () => {
    try {
      window.location.href = buildAuraPlayerUri(mediaUrl, title);
    } catch {
      button.disabled = true;
      button.textContent = "재생 불가";
    }
  });
  meta.append(button);
}

function enhanceCandidates() {
  if (!candidates) return;
  for (const card of candidates.querySelectorAll(".candidate-card")) enhanceCandidateCard(card);
}

if (candidates) {
  const observer = new MutationObserver(enhanceCandidates);
  observer.observe(candidates, { childList: true, subtree: true });
  enhanceCandidates();
}
