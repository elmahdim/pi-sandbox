export interface SandboxViewState {
  name?: string;
  project?: string;
  image?: string;
  network?: "on" | "off";
}

/** Rotating-cube frames for in-progress feedback (start/stop/build). */
export const SPINNER_FRAMES = ["◰", "◳", "◲", "◱"];

/** Build one animated activity line: a spinning cube + the current task. */
export function spinnerLine(frame: number, activity: string) {
  return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${activity}`;
}

/** Keep the boundary explicit: Pi is on the host; only workspace tools are sandboxed. */
export function sandboxView(state: SandboxViewState | undefined, activity?: string) {
  const running = !!state?.name;
  const network = state?.network === "off" ? "OFF — external access blocked" : "ON — internet / LAN access allowed";
  // Full, explicit boundary — surfaced on demand via `/sandbox status`, not kept above the editor.
  const detail = running ? [
    "SANDBOX ACTIVE · workspace tools execute in Podman",
    `Project: ${state?.project} → /workspace · agent-isolated read-write`,
    `Network: ${network} · Image: ${state?.image}`,
    `Container: ${state?.name} · Pi + provider authentication stay on host`,
  ] : [
    "SANDBOX OFF · agent tools blocked — no host fallback",
    "Pi is on the host · /sandbox start to enable sandbox tools",
  ];
  // One informative line above the editor; `/sandbox status` prints the rest.
  const widget = running
    ? `📦 sandbox online · net ${state?.network ?? "on"} · rw · agent-isolated`
    : "📦 sandbox offline · tools locked, no host fallback · /sandbox start";
  return {
    // When something is happening, the activity replaces the static line.
    widget: activity ?? widget,
    detail,
    running,
  };
}
