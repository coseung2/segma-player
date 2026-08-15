// Parallel byte-range reception for server-hosted files. The peer supports
// HTTP range requests, so multiple connections fetch disjoint chunks while a
// bounded buffer hands them to the sink in order. Failed chunks are retried,
// which makes the transfer far more robust than a single browser download
// stream. The sink is sequential (native writer), so out-of-order arrivals
// are buffered and flushed in file order.

export const PARALLEL_CONCURRENCY = 6;
export const PARALLEL_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 3;

async function probeTotal(url, signal) {
  const response = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    cache: "no-store",
    signal,
  });
  if (!response.ok && response.status !== 206) throw new Error(`영상 요청 실패 (${response.status})`);
  const contentRange = response.headers.get("content-range") || "";
  const match = /bytes\s+\d+-\d+\/(\d+)/.exec(contentRange);
  await response.body?.cancel?.().catch(() => {});
  const total = match ? Number(match[1]) : null;
  if (!Number.isFinite(total) || total <= 0) throw new Error("파일 크기를 확인할 수 없습니다.");
  return total;
}

async function fetchRange(url, start, end, signal, attempt = 1, fetchImpl = null, extra = {}) {
  try {
    const response = fetchImpl
      ? await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal, ...extra })
      : await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        cache: "no-store",
        signal,
      });
    if (response.status !== 206) throw new Error(`범위 요청 실패 (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength !== end - start + 1) throw new Error("범위 데이터 길이 불일치");
    return data;
  } catch (error) {
    if (attempt < MAX_RETRIES && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      return fetchRange(url, start, end, signal, attempt + 1, fetchImpl, extra);
    }
    throw error;
  }
}

export async function parallelDownload({
  url,
  filename,
  createSink,
  concurrency = PARALLEL_CONCURRENCY,
  chunkBytes = PARALLEL_CHUNK_BYTES,
  onProgress = null,
  signal = null,
  fetchImpl = null,
  extra = {},
  startOffset = 0,
}) {
  const total = await probeTotal(url, signal);
  const offset = Number.isFinite(startOffset) && startOffset > 0 ? Math.floor(startOffset) : 0;
  const sink = await createSink(filename, offset);
  const ranges = [];
  for (let start = offset; start < total; start += chunkBytes) {
    ranges.push([start, Math.min(start + chunkBytes - 1, total - 1)]);
  }
  let cursor = 0;
  let nextStart = offset;
  let written = offset;
  const pending = new Map();
  async function flush() {
    while (pending.has(nextStart)) {
      const data = pending.get(nextStart);
      pending.delete(nextStart);
      await sink.write(data);
      nextStart += data.byteLength;
      written += data.byteLength;
      if (onProgress) onProgress(written, total);
    }
  }
  async function worker() {
    while (cursor < ranges.length && !signal?.aborted) {
      const [start, end] = ranges[cursor];
      cursor += 1;
      const data = await fetchRange(url, start, end, signal, 1, fetchImpl, extra);
      pending.set(start, data);
      await flush();
    }
  }
  try {
    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(ranges.length, 1)) },
      () => worker(),
    );
    await Promise.all(workers);
    await flush();
    if (written !== total) throw new Error(`저장 크기 불일치 (${written}/${total})`);
    await sink.close();
  } catch (error) {
    try {
      await sink.abort();
    } catch {
      // already closed
    }
    throw error;
  }
  return { bytes: total };
}
