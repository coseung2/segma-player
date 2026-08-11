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

export async function createNativeFileWriter(filename) {
  const jobId = crypto.randomUUID();
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
    if (message.status === "failed") waiter.reject(new Error(message.statusText || message.error || "기본 Downloads 저장에 실패했습니다."));
    else waiter.resolve(message);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    const error = new Error(chrome.runtime.lastError?.message || "기본 Downloads 저장 helper 연결이 끊겼습니다.");
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });

  let opened;
  try {
    opened = await request({ type: "media-open", filename });
  } catch (error) {
    try { port.disconnect(); } catch { /* already disconnected */ }
    throw error;
  }
  return {
    name: opened.fileName || filename,
    async write(params) {
      const value = params?.data ?? params;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const chunk of splitNativeChunks(bytes)) {
        await request({ type: "media-chunk", data: bytesToBase64(chunk) });
      }
    },
    async close() {
      await request({ type: "media-close" });
      try { port.disconnect(); } catch { /* already disconnected */ }
    },
    async abort() {
      try { await request({ type: "media-abort" }); } catch { /* best effort */ }
      try { port.disconnect(); } catch { /* already disconnected */ }
    },
  };
}
