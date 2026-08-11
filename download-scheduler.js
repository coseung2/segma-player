export function createDownloadScheduler({ concurrency = 3 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }

  let activeCount = 0;
  const pending = [];

  function drain() {
    while (activeCount < concurrency && pending.length > 0) {
      const item = pending.shift();
      activeCount += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  }

  return Object.freeze({
    concurrency,
    schedule(task) {
      if (typeof task !== "function") throw new TypeError("task must be a function");
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        drain();
      });
    },
    get activeCount() {
      return activeCount;
    },
    get pendingCount() {
      return pending.length;
    },
  });
}
