const MAX_NATIVE_CHUNK_BYTES = 384 * 1024;

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null;
  if (!bytes) throw new Error("invalid-native-writer-bytes");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

export function splitNativeChunks(value, maximum = MAX_NATIVE_CHUNK_BYTES) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximum) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + maximum)));
  }
  return chunks;
}

export async function createNativeFileWriter(filename, metadata = {}) {
  const requestedJobId = typeof metadata?.jobId === "string" ? metadata.jobId : "";
  const jobId = /^[A-Za-z0-9_-]{1,128}$/.test(requestedJobId)
    ? requestedJobId
    : crypto.randomUUID();
  const port = chrome.runtime.connect({ name: "native-file-writer" });
  const pending = [];
  let disconnected = false;

  function request(message) {
    if (disconnected) return Promise.reject(new Error("기본 Downloads 저장 helper 연결이 끊겼습니다."));
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      try { port.postMessage({ ...message, jobId }); } catch (error) { pending.pop(); reject(error); }
    });
  }

  port.onMessage.addListener((message) => {
    if (message?.jobId !== jobId) return;
    const waiter = pending.shift();
    if (!waiter) return;
    if (message.status === "failed") {
      const error = new Error(message.statusText || message.error || "기본 Downloads 저장에 실패했습니다.");
      if (typeof message.errorCode === "string") error.code = message.errorCode;
      waiter.reject(error);
    } else waiter.resolve(message);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    const error = new Error(chrome.runtime.lastError?.message || "기본 Downloads 저장 helper 연결이 끊겼습니다.");
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });

  let opened;
  try {
    opened = await request({
      type: "media-open",
      filename,
      title: typeof metadata?.title === "string" ? metadata.title : "",
      inputKind: typeof metadata?.inputKind === "string" ? metadata.inputKind : "",
      total: Number.isFinite(metadata?.total) && metadata.total > 0 ? Math.round(metadata.total) : undefined,
      showUi: metadata?.showUi !== false,
      resumeFileName: typeof metadata?.resumeFileName === "string" ? metadata.resumeFileName : "",
      resumeFrom: Number.isFinite(metadata?.resumeFrom) && metadata.resumeFrom >= 0
        ? Math.floor(metadata.resumeFrom)
        : undefined,
    });
  } catch (error) {
    try { port.disconnect(); } catch { /* already disconnected */ }
    throw error;
  }
  let committedBytes = Number.isFinite(opened.bytesWritten) && opened.bytesWritten >= 0
    ? Math.floor(opened.bytesWritten)
    : 0;
  return {
    name: opened.fileName || filename,
    get committedBytes() { return committedBytes; },
    async write(params) {
      const value = params?.data ?? params;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const chunk of splitNativeChunks(bytes)) {
        const response = await request({ type: "media-chunk", data: bytesToBase64(chunk) });
        committedBytes = Number.isFinite(response?.bytesWritten)
          ? Math.floor(response.bytesWritten)
          : committedBytes + chunk.byteLength;
        await metadata?.onCommitted?.(committedBytes);
      }
    },
    async close() {
      const response = await request({ type: "media-close" });
      try { port.disconnect(); } catch { /* already disconnected */ }
      return response;
    },
    async abort() {
      try { await request({ type: "media-abort" }); } catch { /* best effort */ }
      try { port.disconnect(); } catch { /* already disconnected */ }
    },
    async suspend() {
      try {
        const response = await request({ type: "media-suspend" });
        if (Number.isFinite(response?.bytesWritten)) committedBytes = Math.floor(response.bytesWritten);
      } catch { /* a disconnected host still leaves its .part file intact */ }
      try { port.disconnect(); } catch { /* already disconnected */ }
      return committedBytes;
    },
  };
}
