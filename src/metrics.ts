import type { Sandbox } from "./runtime.ts";

/** One bounded request at a time. Disposing aborts only the stats CLI, never the sandbox. */
export function watchMetrics(sandbox: Sandbox, onUpdate: () => void, intervalMs = 5_000): () => void {
  const controller = new AbortController();
  let busy = false;
  const tick = async () => {
    if (busy || controller.signal.aborted || !sandbox.name) return;
    busy = true;
    try {
      await sandbox.refreshMetrics(controller.signal);
      if (!controller.signal.aborted) onUpdate();
    } catch { /* A UI failure must not create an unhandled background rejection. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return () => { clearInterval(timer); controller.abort(); };
}
