import { spawn } from "node:child_process";

export interface RunOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (data: Buffer) => void;
  maxBytes?: number;
}
export interface RunResult { stdout: Buffer; stderr: Buffer; code: number }
export type Runner = (args: string[], options?: RunOptions) => Promise<RunResult>;

// No host shell or arbitrary executable selection. Only these two runtime CLIs.
export function runtimeRunner(executable: "podman" | "container"): Runner {
  return (args, options = {}) => new Promise((resolveResult, reject) => {
    if (options.signal?.aborted) return reject(new Error("Cancelled"));
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("Cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${executable} operation timed out`)), options.timeoutMs ?? 60_000);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 32 * 1024 * 1024)) {
        stop(new Error(`${executable} output exceeded safety limit`)); return;
      }
      if (options.onData) options.onData(chunk); else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.on("error", (error) => { failure = new Error(`${executable}: ${error.message}`, { cause: error }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
    });
  });
}
export const runPodman = runtimeRunner("podman");
export const runApple = runtimeRunner("container");
export function checked(result: RunResult, label = "Podman"): Buffer {
  if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.toString().trim()}`);
  return result.stdout;
}
