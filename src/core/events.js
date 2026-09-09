// Tiny synchronous event bus. Systems talk through this rather than importing
// each other, which is what keeps the throne swap from needing to know about
// particles, audio or the HUD.
export function createEvents() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    once(name, fn) {
      const off = this.on(name, (payload) => { off(); fn(payload); });
      return off;
    },
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set) return;
      // Copy: a handler may unsubscribe itself mid-emit.
      for (const fn of [...set]) fn(payload);
    },
    clear() { handlers.clear(); },
  };
}
