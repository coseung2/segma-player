function downloadError(message, code = "download-failed") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function completedBytes(item) {
  return Math.max(0, ...[item?.fileSize, item?.totalBytes, item?.bytesReceived]
    .map(Number)
    .filter(Number.isFinite));
}

export function createBrowserDownloadMonitor(downloads, {
  creationTimeoutMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof downloads?.download !== "function" || typeof downloads?.search !== "function") {
    throw new TypeError("downloads API is incomplete");
  }

  const byRequest = new Map();
  const byDownload = new Map();

  function cleanup(state) {
    if (state.timer != null) clearTimer(state.timer);
    byRequest.delete(state.requestId);
    if (Number.isInteger(state.downloadId)) byDownload.delete(state.downloadId);
  }

  function fail(state, error) {
    if (state.settled) return;
    state.settled = true;
    cleanup(state);
    state.reject(error);
  }

  async function removeEmptyFile(downloadId) {
    try { await downloads.removeFile?.(downloadId); } catch { /* best effort */ }
  }

  async function inspect(state) {
    if (state.settled || !Number.isInteger(state.downloadId)) return;
    let item;
    try {
      [item] = await downloads.search({ id: state.downloadId });
    } catch {
      fail(state, downloadError("브라우저 다운로드 상태를 확인하지 못했습니다."));
      return;
    }
    if (!item || item.state === "interrupted") {
      fail(state, downloadError(
        item?.error ? `브라우저 다운로드가 중단되었습니다 (${item.error}).` : "브라우저 다운로드가 중단되었습니다.",
        item?.error || "download-interrupted",
      ));
      return;
    }
    if (item.state !== "complete") return;
    const bytes = completedBytes(item);
    if (bytes <= 0) {
      await removeEmptyFile(state.downloadId);
      fail(state, downloadError(
        "영상 서버가 빈 파일을 반환했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요.",
        "empty-download",
      ));
      return;
    }
    state.settled = true;
    cleanup(state);
    state.resolve({ downloadId: state.downloadId, bytes });
  }

  function assign(state, downloadId) {
    if (state.settled || !Number.isInteger(downloadId)) return false;
    state.downloadId = downloadId;
    state.awaitingCreation = false;
    if (state.timer != null) {
      clearTimer(state.timer);
      state.timer = null;
    }
    byDownload.set(downloadId, state);
    void inspect(state);
    return true;
  }

  function makeState(requestId, url, awaitingCreation) {
    if (typeof requestId !== "string" || !requestId || byRequest.has(requestId)) {
      throw downloadError("브라우저 다운로드 요청 식별자가 올바르지 않습니다.", "invalid-download-request");
    }
    const targetUrl = canonicalUrl(url);
    if (!targetUrl) throw downloadError("영상 주소가 올바르지 않습니다.", "invalid-url");
    let resolve;
    let reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const state = {
      requestId,
      url: targetUrl,
      awaitingCreation,
      downloadId: null,
      timer: null,
      settled: false,
      resolve,
      reject,
      result,
    };
    byRequest.set(requestId, state);
    if (awaitingCreation) {
      state.timer = setTimer(() => fail(state, downloadError(
        "영상 프레임에서 브라우저 다운로드가 시작되지 않았습니다.",
        "source-download-not-created",
      )), creationTimeoutMs);
      state.timer?.unref?.();
    }
    return state;
  }

  function handleCreated(item) {
    const itemUrl = canonicalUrl(item?.url);
    if (!itemUrl || !Number.isInteger(item?.id)) return;
    for (const state of byRequest.values()) {
      if (state.awaitingCreation && state.url === itemUrl) {
        assign(state, item.id);
        return;
      }
    }
  }

  function handleChanged(delta) {
    const state = byDownload.get(delta?.id);
    if (!state) return;
    if (delta.state?.current === "interrupted") {
      fail(state, downloadError(
        delta.error?.current ? `브라우저 다운로드가 중단되었습니다 (${delta.error.current}).` : "브라우저 다운로드가 중단되었습니다.",
        delta.error?.current || "download-interrupted",
      ));
      return;
    }
    if (delta.state?.current === "complete") void inspect(state);
  }

  downloads.onCreated?.addListener?.(handleCreated);
  downloads.onChanged?.addListener?.(handleChanged);

  return Object.freeze({
    async start({ requestId, url, options }) {
      const state = makeState(requestId, url, false);
      try {
        const downloadId = await downloads.download(options);
        if (!assign(state, downloadId)) throw downloadError("브라우저 다운로드를 시작하지 못했습니다.");
        return await state.result;
      } catch (error) {
        fail(state, error instanceof Error ? error : downloadError("브라우저 다운로드를 시작하지 못했습니다."));
        return state.result;
      }
    },

    async capture({ requestId, url, trigger }) {
      if (typeof downloads.onCreated?.addListener !== "function") {
        throw downloadError("브라우저 다운로드 감시 기능을 사용할 수 없습니다.");
      }
      const state = makeState(requestId, url, true);
      try {
        const triggered = await trigger();
        if (!triggered) throw downloadError("영상 프레임에서 다운로드를 시작하지 못했습니다.", "source-frame-unavailable");
        return await state.result;
      } catch (error) {
        fail(state, error instanceof Error ? error : downloadError("영상 프레임에서 다운로드를 시작하지 못했습니다."));
        return state.result;
      }
    },

    async cancel(requestId) {
      const state = byRequest.get(requestId);
      if (!state) return false;
      if (Number.isInteger(state.downloadId)) {
        try { await downloads.cancel?.(state.downloadId); } catch { /* best effort */ }
      }
      fail(state, downloadError("사용자가 다운로드를 취소했습니다.", "download-cancelled"));
      return true;
    },

    destroy() {
      downloads.onCreated?.removeListener?.(handleCreated);
      downloads.onChanged?.removeListener?.(handleChanged);
      for (const state of [...byRequest.values()]) {
        fail(state, downloadError("다운로드 감시가 종료되었습니다.", "download-monitor-closed"));
      }
    },
  });
}
