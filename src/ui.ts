export interface SandboxViewState {
  name?: string;
  project?: string;
  image?: string;
  network?: "on" | "off";
}

/** Keep the boundary explicit: Pi is on the host; only workspace tools are sandboxed. */
export function sandboxView(state: SandboxViewState | undefined, activity?: string) {
  const running = !!state?.name;
  const network = state?.network === "off" ? "OFF — external access blocked" : "ON — internet / LAN access allowed";
  const lines = running ? [
    "SANDBOX ACTIVE · workspace tools execute in Podman",
    `Project: ${state?.project} → /workspace · LIVE read-write`,
    `Network: ${network} · Image: ${state?.image}`,
    `Container: ${state?.name} · Pi + provider authentication stay on host`,
  ] : [
    "SANDBOX OFF · agent tools blocked — no host fallback",
    "Pi is on the host · /sandbox start to enable sandbox tools",
  ];
  if (activity) lines.unshift(activity);
  return {
    // undefined removes this extension's entry, not the user's entire Pi footer.
    footer: running ? `sandbox active · net ${state?.network ?? "on"} · live RW` : undefined,
    lines,
    running,
  };
}
