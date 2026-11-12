import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ResourceStats, RuntimeName } from "./backends.ts";

export interface SandboxViewState {
  name?: string;
  project?: string;
  image?: string;
  network?: "on" | "off";
  runtime?: RuntimeName;
  metrics?: ResourceStats;
  metricsState?: "pending" | "available" | "unavailable";
}

export function formatMemory(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}
export function resourceLine(state: SandboxViewState, enabled = true): string {
  if (!enabled) return "stats off";
  if (!state.metrics) return state.metricsState === "unavailable" ? "stats unavailable" : "stats pending";
  const m = state.metrics;
  const cpu = m.cpuPercent === undefined ? "—" : `${m.cpuPercent.toFixed(1)}%`;
  return `cpu ${cpu} · mem ${formatMemory(m.memoryBytes)}/${formatMemory(m.memoryLimitBytes)}`;
}

/** Rotating-cube frames for in-progress feedback (start/stop/build). */
export const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"];

/** Build one animated activity line: a spinning cube + the current task. */
export function spinnerLine(frame: number, activity: string) {
  return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${activity}`;
}

/** Keep the boundary explicit: Pi is on the host; only workspace tools are sandboxed. */
export function sandboxView(state: SandboxViewState | undefined, activity?: string, statsEnabled = true) {
  const running = !!state?.name;
  const network = state?.network === "off" ? "OFF — external access blocked" : "ON — internet / LAN access allowed";
  // Full, explicit boundary — surfaced on demand via `/sandbox`, not kept above the editor.
  const detail = running ? [
    `SANDBOX ACTIVE · workspace tools execute in ${state?.runtime === "apple" ? "Apple Container" : "Podman"}`,
    `Project: ${state?.project} → /workspace · agent-isolated read-write`,
    `Network: ${network} · Image: ${state?.image}`,
    `Container: ${state?.name} · Pi + provider authentication stay on host`,
    `Resources (container workload): ${resourceLine(state!, statsEnabled)}${state?.metrics?.pids === undefined ? "" : ` · ${state.metrics.pids} processes`}`,
    "CPU: 100% = one core. Runtime-reported memory; excludes total host/VM overhead. Samples are not a benchmark.",
  ] : [
    "SANDBOX OFF · agent tools blocked — no host fallback",
    "Chat works; agent file/shell actions (read, write, edit, bash) and !/!! are blocked before execution.",
    "Pi is on the host · /sandbox start to enable sandbox tools",
    "/sandbox → switch runtime, save a default runtime, network, build and cleanup",
    `Project: ${state?.project ?? "not initialized"} → /workspace · read-write`,
    `Runtime: ${state?.runtime ?? "podman"} · Network: ${network} · Image: ${state?.image ?? "not selected"}`,
  ];
  const runtime = state?.runtime === "apple" ? "Apple Container" : "Podman";
  const left = running
    ? `🔒 Tools isolated in ${runtime}`
    : "🔓 Sandbox off · tools blocked · /sandbox start · /sandbox for settings";
  const boundary = `net ${state?.network ?? "on"} · /workspace rw`;
  const resources = state?.metrics && statsEnabled
    ? `cpu ${state.metrics.cpuPercent === undefined ? "—" : `${state.metrics.cpuPercent.toFixed(1)}%`} · mem ${formatMemory(state.metrics.memoryBytes)}`
    : resourceLine(state ?? {}, statsEnabled);
  const right = running ? `${boundary} · ${resources}` : runtime;
  const widget = `${left}  ${right}`;
  // Drop metrics before shortening the runtime; never let the line wrap.
  const renderWidget = (width: number): string => {
    width = Math.max(0, Math.floor(width));
    if (activity) return truncateToWidth(activity, width);
    const compactLeft = running ? `🔒 Tools isolated in ${state?.runtime === "apple" ? "Apple" : "Podman"}` : left;
    const candidates = running
      ? [[left, right], [left, boundary], [compactLeft, boundary], ["🔒 Tools isolated", boundary]]
      : [[left, right], ["🔓 Tools blocked · /sandbox start · /sandbox", right], ["🔓 Tools blocked · /sandbox start · /sandbox", ""]];
    for (const [l, r] of candidates) {
      const gap = width - visibleWidth(l!) - visibleWidth(r!);
      if (gap >= (r ? 2 : 0)) return l + (r ? " ".repeat(gap) + r : "");
    }
    return truncateToWidth(running ? `🔒 Isolated · ${boundary}` : "🔓 Tools blocked · /sandbox start", width);
  };
  return {
    // When something is happening, the activity replaces the static line.
    widget: activity ?? widget,
    renderWidget,
    detail,
    running,
  };
}
