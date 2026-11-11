import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  type BashOperations, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Sandbox, DEFAULT_IMAGE, LABEL, checked, containerPath, runPodman, stopAll, isStarted, type Network } from "./runtime.ts";
import { sandboxView, spinnerLine } from "./ui.ts";

const TOOLS = ["read", "write", "edit", "bash"];
const HELP = "Usage: /sandbox start | stop | status | build | network on|off | cleanup";

export default function (pi: ExtensionAPI) {
  let sandbox: Sandbox | undefined;
  const get = () => {
    if (!sandbox) throw new Error("Sandbox not initialized; host fallback is disabled");
    return sandbox;
  };
  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  const stopSpinner = () => { if (spinner) { clearInterval(spinner); spinner = undefined; } };
  const render = (ctx: ExtensionContext, line: string, color: string) => {
    // Single informative line above the editor; full boundary lives in `/sandbox status`.
    // No footer entry — the aboveEditor widget is the only persistent indicator.
    ctx.ui.setWidget("pi-sandbox", [ctx.ui.theme.fg(color, line)], { placement: "aboveEditor" });
  };
  const status = (ctx: ExtensionContext, activity?: string) => {
    if (!ctx.hasUI) return;
    stopSpinner();
    if (activity) {
      // Animate a rotating cube while the operation is in flight.
      frame = 0;
      render(ctx, spinnerLine(frame, activity), "muted");
      spinner = setInterval(() => render(ctx, spinnerLine(++frame, activity), "muted"), 120);
      return;
    }
    const view = sandboxView(sandbox);
    render(ctx, view.widget, view.running ? "success" : "warning");
  };
  pi.registerFlag("sandbox-auto-start", { description: "Start the sandbox at session startup", type: "boolean", default: false });
  pi.registerFlag("sandbox-image", { description: "Prebuilt Podman image (must include bash, coreutils and file)", type: "string", default: DEFAULT_IMAGE });
  pi.registerFlag("sandbox-network", { description: "Container networking: on (default) or off", type: "string", default: "on" });

  // All file I/O below happens in the container. Content goes via stdin, not shell interpolation.
  const ops = (signal?: AbortSignal) => {
    const s = get();
    const path = (p: string) => containerPath(p, s.project);
    return {
      readFile: (p: string) => s.file(["cat", "--", path(p)], { signal }),
      access: async (p: string) => { await s.file(["test", "-r", path(p)], { signal }); },
      writeFile: async (p: string, content: string) => {
        await s.file(["sh", "-c", 'cat > "$1"', "pi-sandbox-write", path(p)], { input: content, signal });
      },
      mkdir: async (p: string) => { await s.file(["mkdir", "-p", "--", path(p)], { signal }); },
      detectImageMimeType: async (p: string) => {
        const mime = (await s.file(["file", "--mime-type", "-b", "--", path(p)], { signal })).toString().trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
      },
    };
  };
  const bashOps: BashOperations = {
    async exec(command, cwd, { signal, timeout, onData }) {
      const result = await get().exec(["bash", "--noprofile", "--norc", "-c", command], {
        signal, onData, timeoutMs: (timeout ?? 120) * 1000,
      }, cwd);
      return { exitCode: result.code };
    },
  };

  pi.registerTool({
    ...createReadToolDefinition("/workspace"),
    async execute(id, params, signal, update, ctx) {
      try { return await createReadToolDefinition("/workspace", { operations: ops(signal) }).execute(id, params, signal, update, ctx); }
      finally { status(ctx); }
    },
  });
  pi.registerTool({
    ...createWriteToolDefinition("/workspace"),
    async execute(id, params, signal, update, ctx) {
      try { return await createWriteToolDefinition("/workspace", { operations: ops(signal) }).execute(id, params, signal, update, ctx); }
      finally { status(ctx); }
    },
  });
  pi.registerTool({
    ...createEditToolDefinition("/workspace"),
    async execute(id, params, signal, update, ctx) {
      try { return await createEditToolDefinition("/workspace", { operations: ops(signal) }).execute(id, params, signal, update, ctx); }
      finally { status(ctx); }
    },
  });
  pi.registerTool({
    ...createBashToolDefinition("/workspace", { exposeSessionEnvironment: false }),
    async execute(id, params, signal, update, ctx) {
      try {
        return await createBashToolDefinition("/workspace", { operations: bashOps, exposeSessionEnvironment: false })
          .execute(id, params, signal, update, ctx);
      } finally { status(ctx); }
    },
  });

  // An allowlist also blocks tools activated later or called indirectly.
  pi.on("tool_call", (event) => {
    if (!TOOLS.includes(event.toolName)) return { block: true, reason: `pi-sandbox blocks unsupported tool: ${event.toolName}` };
    if (!sandbox?.name) return { block: true, reason: "Sandbox stopped. Ask the user to run /sandbox start. No host fallback." };
  });
  pi.on("user_bash", (_event, ctx) => ({
    operations: {
      async exec(command, _cwd, options) {
        try { return await bashOps.exec(command, "/workspace", options); }
        finally { status(ctx); }
      },
    },
  }));
  pi.on("before_agent_start", (event) => {
    pi.setActiveTools(TOOLS);
    event.systemPromptOptions.cwd = "/workspace";
    event.systemPromptOptions.sections["sandbox"] =
      `Pi runs on the host; read/write/edit/bash execute in a Podman container. ` +
      `The live host project is mounted read-write at /workspace. Use /workspace paths, not host paths. ` +
      `Networking is ${sandbox?.network ?? "on"}. No host fallback or host execution tool exists. ` +
      `If stopped, ask the user to run /sandbox start. Available development tooling is intentionally minimal. ` +
      `Shell calls default to 120 seconds. Cancelling, timing out, or exceeding the 32 MiB transport limit destroys ` +
      `the container (live project changes survive). Background processes last only as long as the sandbox. ` +
      `Large bash output may be spooled by Pi to a host session temp file; it is not a sandbox path. ` +
      `For large output, redirect it into /workspace and read it in chunks instead.`;
  });
  pi.on("session_start", async (_event, ctx) => {
    // Canonicalize the one intentional host mount; never read project-local config.
    const project = await realpath(ctx.cwd);
    const network = pi.getFlag("sandbox-network");
    if (network !== "on" && network !== "off") throw new Error("--sandbox-network must be on or off");
    sandbox = new Sandbox(project, String(pi.getFlag("sandbox-image") ?? DEFAULT_IMAGE), network as Network, runPodman, ctx.sessionManager.getSessionId());
    pi.setActiveTools(TOOLS);
    status(ctx);
    // A switch or reload within this process preserves the container; reattach to it
    // instead of making a new one. Only probe Podman when this process already owns a
    // container for this session, so a plain startup stays side-effect free.
    if (isStarted(sandbox.containerName)) {
      try { await sandbox.adopt(); } catch { /* fall through to a fresh start */ }
    }
    if (!sandbox.name && pi.getFlag("sandbox-auto-start")) {
      status(ctx, "Starting sandbox…");
      try { await sandbox.start(); }
      catch (error) { ctx.ui.notify(`Sandbox startup failed; tools blocked: ${error}`, "error"); }
    } else if (!sandbox.name && ctx.hasUI) {
      ctx.ui.notify("pi-sandbox loaded; tools blocked until /sandbox start. First use: /sandbox build", "info");
    }
    status(ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // Only a real exit tears containers down. Session switches and reloads keep this
    // session's container running so returning to it reattaches without a restart, and
    // so other sessions' sandboxes keep running in parallel, undisturbed.
    try {
      if (event.reason === "quit") { await sandbox?.stop(); await stopAll(); }
      else sandbox?.detach();
    }
    finally {
      stopSpinner();
      if (ctx.hasUI) {
        ctx.ui.setStatus("pi-sandbox", undefined);
        ctx.ui.setWidget("pi-sandbox", undefined);
      }
    }
  });

  pi.registerCommand("sandbox", {
    description: "Manage Podman sandbox: start, stop, status, build, network on|off, cleanup",
    getArgumentCompletions(prefix) {
      return ["start", "stop", "status", "build", "network on", "network off", "cleanup"]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the agent to finish before managing its sandbox", "warning"); return; }
      const action = args.trim() || "status";
      try {
        const s = get();
        const activities: Record<string, string> = {
          start: "Starting sandbox…", stop: "Stopping sandbox…",
          build: "Building shared toolbox image… (host-side Podman build; network required)",
          "network on": "Enabling network… (running container will be recreated)",
          "network off": "Disabling network… (running container will be recreated)",
        };
        if (activities[action]) status(ctx, activities[action]);
        if (action === "start") await s.start();
        else if (action === "stop") await s.stop();
        else if (action === "status") {
          let state = "stopped";
          if (s.name) {
            const result = await runPodman(["inspect", "--format", "{{.State.Status}}", s.name]);
            state = result.code === 0 ? result.stdout.toString().trim() : "missing or unavailable";
            if (state !== "running") await s.stop();
          }
          ctx.ui.notify(`Sandbox: ${state}\nProject: ${s.project} → /workspace (read-write)\nImage: ${s.image}\nNetwork: ${s.network}\nContainer: ${s.name ?? "none"}`, "info");
        } else if (action === "build") {
          const context = fileURLToPath(new URL("../container/", import.meta.url));
          ctx.ui.notify("Building shared toolbox image; this may take a few minutes…", "info");
          checked(await runPodman(["build", "--tag", s.image, "--file", `${context}Containerfile`, context], { timeoutMs: 600_000 }));
        } else if (action === "network on" || action === "network off") {
          const next = action.endsWith(" off") ? "off" : "on";
          if (s.network !== next) {
            const running = !!s.name;
            await s.stop(); s.network = next;
            if (running) await s.start();
          }
        } else if (action === "cleanup") {
          // Never prune images, volumes, active sessions, or unrelated containers.
          const ids = checked(await runPodman(["ps", "--all", "--quiet", "--filter", `label=${LABEL}`, "--filter", "status=exited"]))
            .toString().trim().split(/\s+/).filter(Boolean);
          if (!ids.length) { ctx.ui.notify("No stopped pi-sandbox containers to remove", "info"); return; }
          if (!ctx.hasUI || !await ctx.ui.confirm("Remove stopped sandboxes?", `${ids.length} stopped managed container(s). No images or volumes will be deleted.`)) return;
          // No --force: a container started since the listing must not be killed.
          checked(await runPodman(["rm", "--ignore", ...ids]));
        } else { ctx.ui.notify(HELP, "info"); return; }
        if (action === "stop") ctx.ui.notify("Sandbox stopped. Agent tools are blocked; nothing switched to host execution. Live project changes are preserved.", "info");
        else if (action !== "status") ctx.ui.notify(`Sandbox: ${action} complete`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Sandbox ${action} failed: ${message}`, "error");
      }
      finally { status(ctx); }
    },
  });
}
