import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { createBackend, DEFAULT_IMAGE, MissingImageError, type Network, type RuntimeBackend, type RuntimeName, type ResourceStats } from "./backends.ts";
import { checked, type Runner, type RunOptions, type RunResult } from "./process.ts";
export { DEFAULT_IMAGE, LABEL, runArgs, parseRuntime, type Network, type RuntimeName } from "./backends.ts";
export { checked, runPodman, runApple, type Runner, type RunOptions, type RunResult } from "./process.ts";

// Translate only an exact project prefix. Other absolute paths are container paths.
export function containerPath(path: string, project: string): string {
  const rel = relative(project, path);
  if (rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))) {
    return rel ? `/workspace/${rel}` : "/workspace";
  }
  return path;
}
interface OwnedContainer { name: string; backend: RuntimeBackend; config: string }
const started = new Map<string, OwnedContainer>();
const key = (name: string, runtime: RuntimeName) => `${runtime}:${name}`;
export function isStarted(name: string, runtime: RuntimeName = "podman") { return started.has(key(name, runtime)); }
export async function stopAll(run?: Runner) {
  for (const [id, owned] of [...started]) {
    try {
      await (run ? createBackend(owned.backend.id, run) : owned.backend).remove(owned.name);
      started.delete(id);
    } catch { /* Keep failed removals tracked for another cleanup attempt. */ }
  }
}

export class Sandbox {
  name: string | undefined;
  private leftover: string | undefined;
  private generation = 0;
  metrics: ResourceStats | undefined;
  metricsState: "pending" | "available" | "unavailable" = "pending";
  startDurationMs: number | undefined;
  readonly containerName: string;
  readonly backend: RuntimeBackend;
  readonly run: Runner;
  constructor(public project: string, public image = DEFAULT_IMAGE, public network: Network = "on", run?: Runner,
    public readonly id: string = randomUUID(), public readonly runtime: RuntimeName = "podman") {
    this.project = resolve(project);
    this.backend = createBackend(runtime, run);
    this.run = this.backend.run;
    // Preserve existing Podman session names; isolate Apple names and ownership too.
    this.containerName = `pi-sandbox-${runtime === "apple" ? "apple-" : ""}${id}`;
  }
  private configKey() { return JSON.stringify([this.project, this.image, this.network]); }
  private track(name: string) { started.set(key(name, this.runtime), { name, backend: this.backend, config: this.configKey() }); }
  async adopt(): Promise<boolean> {
    if (this.name) return true;
    const owned = started.get(key(this.containerName, this.runtime));
    if (owned && owned.config !== this.configKey()) throw new Error("Sandbox configuration changed; stop/recreate it before reattaching");
    if (await this.backend.inspect(this.containerName) === "running") {
      this.name = this.containerName;
      this.leftover = undefined;
      this.track(this.name);
      return true;
    }
    return false;
  }
  private resetMetrics() {
    this.generation++;
    this.metrics = undefined;
    this.metricsState = "pending";
  }
  detach() {
    this.name = undefined;
    this.leftover = undefined;
    this.resetMetrics();
  }
  async start() {
    if (this.name) return;
    const name = this.containerName;
    const args = this.backend.runArgs({ name, project: this.project, image: this.image, network: this.network });
    await this.backend.prepare(this.image);
    // Apple has neither --replace nor --ignore; never force-remove a name collision.
    if (this.runtime === "apple") await this.backend.remove(name, false);
    this.leftover = name;
    this.resetMetrics();
    const begin = performance.now();
    try {
      checked(await this.run(args), this.backend.label);
      this.name = name;
      this.startDurationMs = performance.now() - begin;
      this.track(name);
    } catch (error) {
      await this.stop().catch(() => {});
      if (/image not known|image not found|no such image/i.test(String(error))) {
        throw new MissingImageError(this.image);
      }
      throw error;
    }
  }
  async stop() {
    // An owned container with changed startup settings may be deliberately unadopted.
    // Explicit stop must still be able to remove it without enabling tools first.
    const name = this.name ?? this.leftover ?? (isStarted(this.containerName, this.runtime) ? this.containerName : undefined);
    this.name = undefined; // Fail closed even if removal fails.
    this.resetMetrics();
    this.startDurationMs = undefined;
    if (!name) return;
    this.leftover = name;
    await this.backend.remove(name);
    started.delete(key(name, this.runtime));
    this.leftover = undefined;
  }
  async refreshMetrics(signal?: AbortSignal) {
    const name = this.name, generation = this.generation;
    if (!name) return;
    try {
      const metrics = await this.backend.stats(name, signal);
      if (generation !== this.generation || signal?.aborted) return;
      this.metrics = metrics;
      this.metricsState = "available";
    } catch {
      // Observability failure must never destroy a working sandbox or keep stale data.
      if (generation !== this.generation || signal?.aborted) return;
      this.metrics = undefined;
      this.metricsState = "unavailable";
    }
  }
  async exec(argv: string[], options: RunOptions = {}, cwd = "/workspace"): Promise<RunResult> {
    const name = this.name;
    if (!name) throw new Error("Sandbox stopped. Run /sandbox start. Host fallback is disabled.");
    try {
      return await this.run(this.backend.execArgs(name, containerPath(cwd, this.project), argv), options);
    } catch (error) {
      // Killing the host CLI does not guarantee container-side descendants stop.
      await this.stop().catch(() => {});
      throw error;
    }
  }
  async file(argv: string[], options: RunOptions = {}) {
    return checked(await this.exec(argv, options), this.backend.label);
  }
}
