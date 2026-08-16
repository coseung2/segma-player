function loaderError(error) {
  return {
    code: 0,
    text: typeof error?.message === "string" ? error.message : "media-context-unavailable",
  };
}

export function createContextualHlsLoader(BaseLoader, {
  acquire,
  release,
} = {}) {
  if (typeof BaseLoader !== "function" || typeof acquire !== "function" || typeof release !== "function") {
    throw new TypeError("invalid-contextual-hls-loader");
  }

  return class ContextualHlsLoader {
    constructor(config) {
      this.inner = new BaseLoader(config);
      this.pending = null;
      this.lease = null;
      this.aborted = false;
      this.destroyed = false;
    }

    get context() {
      return this.inner?.context || null;
    }

    get stats() {
      return this.inner?.stats || null;
    }

    async releaseLease() {
      const lease = this.lease;
      this.lease = null;
      if (lease == null) return;
      try { await release(lease); } catch { /* lease cleanup is best effort */ }
    }

    load(context, config, callbacks) {
      if (this.destroyed) return;
      this.aborted = false;
      const url = typeof context?.url === "string" ? context.url : "";
      this.pending = Promise.resolve().then(() => acquire(url, context)).then((lease) => {
        this.pending = null;
        if (this.aborted || this.destroyed) {
          return Promise.resolve(release(lease)).catch(() => {});
        }
        this.lease = lease;
        const wrappedCallbacks = {
          ...callbacks,
          onSuccess: (...args) => {
            void this.releaseLease();
            callbacks?.onSuccess?.(...args);
          },
          onError: (...args) => {
            void this.releaseLease();
            callbacks?.onError?.(...args);
          },
          onTimeout: (...args) => {
            void this.releaseLease();
            callbacks?.onTimeout?.(...args);
          },
          onAbort: (...args) => {
            void this.releaseLease();
            callbacks?.onAbort?.(...args);
          },
        };
        this.inner.load(context, config, wrappedCallbacks);
        return null;
      }).catch((error) => {
        this.pending = null;
        void this.releaseLease();
        if (this.aborted || this.destroyed) return;
        callbacks?.onError?.(loaderError(error), context, null, this.stats);
      });
    }

    abort() {
      this.aborted = true;
      try { this.inner?.abort?.(); } catch { /* optional loader API */ }
      void this.releaseLease();
    }

    destroy() {
      this.destroyed = true;
      this.abort();
      try { this.inner?.destroy?.(); } catch { /* optional loader API */ }
      this.inner = null;
    }
  };
}
