import { homedir } from "node:os";
import { checked, runApple, runPodman, type Runner, type RunOptions } from "./process.ts";

export const LABEL = "io.pi-sandbox.managed=1";
export const DEFAULT_IMAGE = "localhost/pi-sandbox:0.1";
export class MissingImageError extends Error {
  constructor(image: string) {
    super(`Sandbox image ${image} is not available locally. Open /sandbox and choose Build/rebuild image, then /sandbox start. Images are shared within each runtime.`);
    this.name = "MissingImageError";
  }
}
export type Network = "on" | "off";
export type RuntimeName = "podman" | "apple";
export function parseRuntime(value: unknown): RuntimeName {
  if (value !== "podman" && value !== "apple") throw new Error("--sandbox-runtime must be podman or apple");
  return value;
}
export interface ResourceStats {
  cpuPercent?: number; // 100% means one fully occupied core, not the whole allocation.
  memoryBytes?: number;
  memoryLimitBytes?: number;
  pids?: number;
  sampledAt: number;
}
export interface ContainerConfig { name: string; project: string; image: string; network: Network }
export interface RuntimeBackend {
  id: RuntimeName;
  label: string;
  run: Runner;
  limits: string;
  prepare(image: string): Promise<void>;
  runArgs(config: ContainerConfig): string[];
  execArgs(name: string, cwd: string, argv: string[]): string[];
  inspect(name: string): Promise<string>;
  remove(name: string, force?: boolean): Promise<void>;
  build(image: string, context: string): Promise<void>;
  stopped(): Promise<string[]>;
  stats(name: string, signal?: AbortSignal): Promise<ResourceStats>;
}

export function validateConfig({ name, project, image }: ContainerConfig) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Invalid sandbox container name");
  if (project === "/" || project === homedir()) throw new Error("Refusing to mount your home directory or filesystem root");
  if (/[,\n\r:]/.test(project)) throw new Error("Project paths containing commas, colons or newlines are unsupported");
  if (!image || image.startsWith("-")) throw new Error("Invalid sandbox image");
}
export function runArgs(name: string, project: string, image: string, network: Network): string[] {
  validateConfig({ name, project, image, network });
  return ["run", "--detach", "--rm", "--replace", "--pull=never", "--name", name, "--label", LABEL,
    "--label", `io.pi-sandbox.created=${Date.now()}`, "--userns=keep-id",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
    "--pids-limit=256", "--memory=1g", "--cpus=2", "--network", network === "off" ? "none" : "bridge",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--env", "HOME=/tmp/home",
    "--mount", `type=bind,source=${project},target=/workspace`, "--workdir", "/workspace",
    "--entrypoint", "/bin/sh", image, "-c", "mkdir -p /tmp/home && exec sleep infinity"];
}
const user = () => `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`;
export function appleRunArgs(config: ContainerConfig): string[] {
  validateConfig(config);
  return ["run", "--detach", "--name", config.name, "--label", LABEL,
    "--label", `io.pi-sandbox.created=${Date.now()}`, "--user", user(),
    "--cap-drop", "ALL", "--read-only", "--ulimit", "nproc=256:256",
    "--memory", "1G", "--cpus", "2", "--network", config.network === "off" ? "none" : "default",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--env", "HOME=/tmp/home",
    "--mount", `type=bind,source=${config.project},target=/workspace`, "--workdir", "/workspace",
    "--entrypoint", "/usr/bin/setpriv", config.image, "--no-new-privs", "--", "/bin/sh", "-c",
    "mkdir -p /tmp/home && exec sleep infinity"];
}
const finite = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
export function parseBytes(value: string): number | undefined {
  const match = /^\s*([\d.]+)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)?\s*$/i.exec(value);
  if (!match) return undefined;
  const unit = (match[2] ?? "B").toLowerCase();
  const power = ["b", "k", "m", "g", "t"].indexOf(unit[0]);
  const n = finite(match[1]);
  return n === undefined ? undefined : n * (unit.includes("i") ? 1024 : 1000) ** power;
}
export function parsePodmanStats(text: string): ResourceStats {
  const parts = text.trim().split("|");
  if (parts.length !== 3) throw new Error("Invalid Podman stats response");
  const memory = parts[1].split("/");
  const stats: ResourceStats = {
    cpuPercent: finite(parts[0].trim().replace(/%$/, "")),
    memoryBytes: parseBytes(memory[0]), memoryLimitBytes: parseBytes(memory[1] ?? ""),
    pids: finite(parts[2].trim()), sampledAt: Date.now(),
  };
  if (stats.cpuPercent === undefined && stats.memoryBytes === undefined) throw new Error("Podman stats unavailable");
  return stats;
}
export function parseAppleStats(text: string, name: string): ResourceStats {
  const rows = JSON.parse(text);
  const row = Array.isArray(rows) ? rows.find((r: any) => r.id === name) : undefined;
  if (!row) throw new Error("Apple Container stats unavailable");
  const cpu = finite(row.cpuUtilization);
  const stats: ResourceStats = {
    cpuPercent: cpu === undefined ? undefined : cpu * 100,
    memoryBytes: finite(row.memoryUsageBytes), memoryLimitBytes: finite(row.memoryLimitBytes),
    pids: finite(row.numProcesses), sampledAt: Date.now(),
  };
  if (stats.cpuPercent === undefined && stats.memoryBytes === undefined) throw new Error("Apple Container stats unavailable");
  return stats;
}
const metricOptions = (signal?: AbortSignal): RunOptions => ({ timeoutMs: 5_000, maxBytes: 256 * 1024, signal });
const missing = (result: { stderr: Buffer }) => /not found|no such container|does not exist/i.test(result.stderr.toString());

export function createBackend(id: RuntimeName, runner?: Runner): RuntimeBackend {
  const run = runner ?? (id === "podman" ? runPodman : runApple);
  const label = id === "podman" ? "Podman" : "Apple Container";
  const check = (result: Parameters<typeof checked>[0]) => checked(result, label);
  const build = async (image: string, context: string) => {
    if (!image || image.startsWith("-")) throw new Error("Invalid sandbox image");
    check(await run(["build", "--tag", image, "--file", `${context}Containerfile`, context], { timeoutMs: 600_000 }));
  };
  if (id === "podman") return {
    id, label, run, build, limits: "2 CPUs · 1 GiB memory · 256 PIDs · 256 MiB /tmp",
    async prepare() {},
    runArgs: (c) => runArgs(c.name, c.project, c.image, c.network),
    execArgs: (name, cwd, argv) => ["exec", "--interactive", "--workdir", cwd, name, ...argv],
    async inspect(name) {
      const result = await run(["inspect", "--format", "{{.State.Running}}", name]);
      if (result.code !== 0) return "missing or unavailable";
      return result.stdout.toString().trim() === "true" ? "running" : "stopped";
    },
    async remove(name, force = true) { check(await run(["rm", ...(force ? ["--force"] : []), "--ignore", name], { timeoutMs: 15_000 })); },
    async stopped() {
      return check(await run(["ps", "--all", "--quiet", "--filter", `label=${LABEL}`, "--filter", "status=exited"]))
        .toString().trim().split(/\s+/).filter(Boolean);
    },
    async stats(name, signal) {
      return parsePodmanStats(check(await run(["stats", "--no-stream", "--format", "{{.CPU}}|{{.MemUsage}}|{{.PIDs}}", name], metricOptions(signal))).toString());
    },
  };
  return {
    id, label, run, build, limits: "2 workload CPUs · 1 GiB VM memory · 256 processes/user (not a PID cgroup) · 256 MiB /tmp",
    async prepare(image) {
      // Explicitly fail on older CLIs instead of dropping unsupported hardening.
      const help = check(await run(["run", "--help"])).toString();
      for (const flag of ["--read-only", "--cap-drop", "--tmpfs", "--ulimit"]) {
        if (!help.includes(flag)) throw new Error(`Apple Container lacks ${flag}; upgrade container (adapter targets 1.7.1). No fallback.`);
      }
      const result = await run(["image", "inspect", image]);
      if (result.code !== 0) {
        if (/not found|no such image|does not exist/i.test(result.stderr.toString())) throw new MissingImageError(image);
        check(result); // Service/permission errors are not an invitation to build.
      }
    },
    runArgs: appleRunArgs,
    execArgs: (name, cwd, argv) => ["exec", "--interactive", "--user", user(), "--workdir", cwd, name,
      "/usr/bin/setpriv", "--no-new-privs", "--", ...argv],
    async inspect(name) {
      const result = await run(["inspect", name]);
      if (result.code !== 0) return "missing or unavailable";
      const rows = JSON.parse(result.stdout.toString());
      const row = Array.isArray(rows) ? rows.find((r: any) => r.configuration?.id === name) : undefined;
      if (typeof row?.status !== "string") throw new Error("Unrecognized Apple Container inspect response");
      return row.status;
    },
    async remove(name, force = true) {
      const result = await run(["delete", ...(force ? ["--force"] : []), name], { timeoutMs: 15_000 });
      if (result.code !== 0 && !missing(result)) check(result);
    },
    async stopped() {
      const rows = JSON.parse(check(await run(["list", "--all", "--format", "json"])).toString());
      if (!Array.isArray(rows)) throw new Error("Unrecognized Apple Container list response");
      return rows.filter((r: any) => r.status === "stopped" && r.configuration?.labels?.["io.pi-sandbox.managed"] === "1")
        .map((r: any) => r.configuration.id).filter((name: unknown): name is string => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name));
    },
    async stats(name, signal) {
      return parseAppleStats(check(await run(["stats", "--no-stream", "--format", "json", name], metricOptions(signal))).toString(), name);
    },
  };
}
