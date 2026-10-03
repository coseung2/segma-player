export interface PreviewTarget {
  identity: string;
  folder: string | null;
  fileName: string;
  timestampSeconds: number;
  durationSeconds: number;
}

export interface PreviewFrame { url: string; timestampSeconds: number; }
export interface PreviewState {
  status: "idle" | "loading" | "ready" | "unavailable";
  frame: PreviewFrame | null;
}

// Match the native half-second cache slots, including its end-of-file margin.
export function previewTimestamp(time: number, duration: number): number {
  return Math.floor(Math.max(0, Math.min(time, Math.max(0, duration - 0.5))) * 2) / 2;
}

/** One running request plus one replaceable target. Same-slot hover events
 * must not invalidate the only frame that can satisfy them. */
export function createSeekPreview(
  generate: (target: PreviewTarget) => Promise<PreviewFrame | null>,
  publish: (state: PreviewState) => void,
  isCurrent: (identity: string) => boolean,
) {
  let desired: PreviewTarget | null = null;
  let generation = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStarted = -Infinity;
  let completed: PreviewTarget | null = null;

  const same = (a: PreviewTarget | null, b: PreviewTarget | null) => Boolean(
    a && b && a.identity === b.identity && a.timestampSeconds === b.timestampSeconds,
  );

  function schedule(): void {
    if (running || timer !== null || !desired || same(desired, completed)) return;
    timer = setTimeout(() => { timer = null; void flush(); }, Math.max(0, 180 - (Date.now() - lastStarted)));
  }

  async function flush(): Promise<void> {
    const target = desired;
    if (!target || !isCurrent(target.identity)) return;
    const version = generation;
    running = true;
    lastStarted = Date.now();
    try {
      const frame = await generate(target);
      if (version === generation && same(desired, target) && isCurrent(target.identity)) {
        completed = target;
        publish({ status: frame ? "ready" : "unavailable", frame });
      }
    } catch {
      if (version === generation && same(desired, target) && isCurrent(target.identity)) {
        completed = target;
        publish({ status: "unavailable", frame: null });
      }
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    request(target: PreviewTarget): void {
      if (!Number.isFinite(target.timestampSeconds) || !Number.isFinite(target.durationSeconds) || target.durationSeconds <= 0) return;
      const next = { ...target, timestampSeconds: previewTimestamp(target.timestampSeconds, target.durationSeconds) };
      if (same(desired, next)) return;
      desired = next;
      completed = null;
      publish({ status: "loading", frame: null });
      schedule();
    },
    clear(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      generation += 1;
      desired = null;
      completed = null;
      publish({ status: "idle", frame: null });
    },
  };
}
