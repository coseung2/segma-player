export function createDownloadScheduler({ concurrency = 3 } = {}) {
  if (concurrency !== null && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new TypeError("concurrency must be a positive integer or null for unlimited");
  }

  let activeCount = 0;
  const pending = [];

  function drain() {
    while ((concurrency === null || activeCount < concurrency) && pending.length > 0) {
      const resolve = pending.shift();
      activeCount += 1;
      resolve();
    }
  }

  function acquire() {
    return new Promise((resolve) => {
      pending.push(resolve);
      drain();
    });
  }

  function setConcurrency(value) {
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      throw new TypeError("concurrency must be a positive integer or null for unlimited");
    }
    concurrency = value;
    drain();
  }

  return Object.freeze({
    get concurrency() {
      return concurrency;
    },
    setConcurrency,
    schedule(task) {
      if (typeof task !== "function") throw new TypeError("task must be a function");
      let leaseState = "waiting";
      let resumePromise = acquire();
      const lease = Object.freeze({
        suspend() {
          if (leaseState !== "holding") return Promise.resolve();
          leaseState = "suspended";
          activeCount -= 1;
          drain();
          return Promise.resolve();
        },
        resume() {
          if (leaseState === "holding") return Promise.resolve();
          if (leaseState === "waiting") return resumePromise;
          if (leaseState !== "suspended") return Promise.resolve();
          leaseState = "waiting";
          resumePromise = acquire().then(() => {
            if (leaseState === "waiting") leaseState = "holding";
          });
          return resumePromise;
        },
      });
      return resumePromise.then(async () => {
        leaseState = "holding";
        try {
          return await task(lease);
        } finally {
          if (leaseState === "holding") {
            activeCount -= 1;
            drain();
          }
          leaseState = "finished";
        }
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
