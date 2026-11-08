import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";

export const LABEL = "io.pi-sandbox.managed=1";
export const DEFAULT_IMAGE = "localhost/pi-sandbox:0.1";
export type Network = "on" | "off";
export interface RunOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (data: Buffer) => void;
  maxBytes?: number;
}
export interface RunResult { stdout: Buffer; stderr: Buffer; code: number }
export type Runner = (args: string[], options?: RunOptions) => Promise<RunResult>;

// No shell on the host. Only the fixed Podman executable receives arguments.
export const runPodman: Runner = (args, options = {}) => new Promise((resolveResult, reject) => {
  if (options.signal?.aborted) return reject(new Error("Cancelled"));
  const child = spawn("podman", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, failure: Error | undefined;
  const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
  const abort = () => stop(new Error("Cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Error("Podman operation timed out")), options.timeoutMs ?? 60_000);
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size > (options.maxBytes ?? 32 * 1024 * 1024)) {
      stop(new Error("Podman output exceeded safety limit")); return;
    }
    if (options.onData) options.onData(chunk); else chunks.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  child.stdin.on("error", () => {}); // Early exit can close stdin before a write completes.
  child.stdin.end(options.input);
  child.on("error", (error) => { failure = error; });
  child.on("close", (code) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (failure) reject(failure);
    else resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
  });
});

export function checked(result: RunResult): Buffer {
  if (result.code !== 0) throw new Error(`Podman failed (${result.code}): ${result.stderr.toString().trim()}`);
  return result.stdout;
}

// Translate only an exact project prefix, never arbitrary substring matches.
// Other absolute paths refer to the CONTAINER filesystem, not the host.
export function containerPath(path: string, project: string): string {
  const rel = relative(project, path);
  if (rel === "" || (!rel.startsWith(".." + "/") && rel !== ".." && !isAbsolute(rel))) {
    return rel ? `/workspace/${rel}` : "/workspace";
  }
  return path;
}

export function runArgs(name: string, project: string, image: string, network: Network): string[] {
  if (project === "/" || project === homedir()) throw new Error("Refusing to mount your home directory or filesystem root");
  if (/[,:\n\r]/.test(project)) throw new Error("Project paths containing commas, colons or newlines are unsupported");
  if (!image || image.startsWith("-")) throw new Error("Invalid sandbox image");
  return ["run", "--detach", "--rm", "--pull=never", "--name", name, "--label", LABEL,
    "--label", `io.pi-sandbox.created=${Date.now()}`, "--userns=keep-id",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
    "--pids-limit=256", "--memory=1g", "--cpus=2", "--network", network === "off" ? "none" : "bridge",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--env", "HOME=/tmp/home",
    "--mount", `type=bind,source=${project},target=/workspace`, "--workdir", "/workspace",
    "--entrypoint", "/bin/sh", image, "-c", "mkdir -p /tmp/home && exec sleep infinity"];
}

export class Sandbox {
  name: string | undefined;
  private leftover: string | undefined;
  constructor(public project: string, public image = DEFAULT_IMAGE, public network: Network = "on", public run: Runner = runPodman) {
    this.project = resolve(project);
  }
  async start() {
    if (this.name) return;
    if (this.leftover) await this.stop();
    const name = `pi-sandbox-${randomUUID()}`;
    const args = runArgs(name, this.project, this.image, this.network);
    this.leftover = name;
    try {
      checked(await this.run(args));
      this.name = name;
    } catch (error) {
      await this.stop().catch(() => {});
      if (/image not known|image not found|no such image/i.test(String(error))) {
        throw new Error(`Sandbox image ${this.image} is not available locally. Run /sandbox build, then /sandbox start. Images are shared across project directories.`, { cause: error });
      }
      throw error;
    }
  }
  async stop() {
    const name = this.name ?? this.leftover;
    this.name = undefined; // Fail closed even if removal fails.
    if (!name) return;
    this.leftover = name;
    checked(await this.run(["rm", "--force", "--ignore", name], { timeoutMs: 15_000 }));
    this.leftover = undefined;
  }
  async exec(argv: string[], options: RunOptions = {}, cwd = "/workspace"): Promise<RunResult> {
    const name = this.name;
    if (!name) throw new Error("Sandbox stopped. Run /sandbox start. Host fallback is disabled.");
    try {
      return await this.run(["exec", "--interactive", "--workdir", containerPath(cwd, this.project), name, ...argv], options);
    } catch (error) {
      // Killing the host CLI does NOT guarantee container processes stop.
      // Destroy the entire sandbox on cancellation, deadline or transport failure.
      await this.stop().catch(() => {});
      throw error;
    }
  }
  async file(argv: string[], options: RunOptions = {}) {
    return checked(await this.exec(argv, options));
  }
}
