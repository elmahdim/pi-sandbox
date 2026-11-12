import { truncateToWidth } from "@earendil-works/pi-tui";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  type BashOperations, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Sandbox, DEFAULT_IMAGE, containerPath, stopAll, isStarted, parseRuntime, type Network } from "./runtime.ts";
import { sandboxView, spinnerLine } from "./ui.ts";
import { watchMetrics } from "./metrics.ts";
import { MissingImageError } from "./backends.ts";
import { readDefaultRuntime, saveDefaultRuntime, settingsPath } from "./settings.ts";

const TOOLS = ["read", "write", "edit", "bash"];
const HELP = "Usage: /sandbox (status, runtime switching, saved default runtime, network and maintenance) | /sandbox start | /sandbox stop";

export default function (pi: ExtensionAPI) {
  let sandbox: Sandbox | undefined;
  let defaultRuntime: "podman" | "apple" = "podman";
  const get = () => {
    if (!sandbox) throw new Error("Sandbox not initialized; host fallback is disabled");
    return sandbox;
  };
  let statsEnabled = true;
  let disposeMetrics: (() => void) | undefined;
  let metricsTarget: Sandbox | undefined;
  const stopMetrics = () => { disposeMetrics?.(); disposeMetrics = undefined; metricsTarget = undefined; };
  const syncMetrics = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !statsEnabled || !sandbox?.name) { stopMetrics(); return; }
    if (metricsTarget === sandbox) return;
    stopMetrics();
    metricsTarget = sandbox;
    disposeMetrics = watchMetrics(sandbox, () => {
      if (!spinner && sandbox === metricsTarget) {
        const view = sandboxView(sandbox, undefined, statsEnabled);
        render(ctx, view.widget, view.running ? "success" : "warning", view.renderWidget);
      }
    });
  };
  let spinner: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  const stopSpinner = () => { if (spinner) { clearInterval(spinner); spinner = undefined; } };
  const render = (ctx: ExtensionContext, line: string, color: "success" | "warning" | "muted", layout?: (width: number) => string) => {
    // Keep RPC's text widget; only the TUI supports responsive component factories.
    ctx.ui.setWidget("pi-sandbox", ctx.mode === "tui" ? (_tui, theme) => ({
      render: (width) => [theme.fg(color, layout ? layout(width) : truncateToWidth(line, width))],
      invalidate() {},
    }) : [ctx.ui.theme.fg(color, line)], { placement: "aboveEditor" });
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
    syncMetrics(ctx);
    const view = sandboxView(sandbox, undefined, statsEnabled);
    render(ctx, view.widget, view.running ? "success" : "warning", view.renderWidget);
  };
  pi.registerFlag("sandbox-auto-start", { description: "Start the sandbox at session startup", type: "boolean", default: false });
  pi.registerFlag("sandbox-image", { description: "Prebuilt image in the selected runtime's image store", type: "string", default: DEFAULT_IMAGE });
  pi.registerFlag("sandbox-runtime", { description: "Container runtime: podman or apple (overrides saved default; otherwise podman)", type: "string" });
  pi.registerFlag("sandbox-stats", { description: "Periodic container CPU/memory indicator: on (default) or off", type: "string", default: "on" });
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
    if (!TOOLS.includes(event.toolName)) return { block: true, reason: `pi-sandbox blocks unsupported tool: ${event.toolName}. Only read, write, edit and bash have sandbox-backed implementations.` };
    if (!sandbox?.name) return { block: true, reason: "Sandbox stopped. Agent file/shell actions (read, write, edit, bash) are blocked before execution; chat still works. Ask the user to run /sandbox start, or /sandbox to switch runtime, save a default runtime, or manage settings. No host fallback." };
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
      `Pi runs on the host; read/write/edit/bash execute in a ${sandbox?.backend.label ?? "selected runtime"} container. ` +
      `The live host project is mounted read-write at /workspace. Use /workspace paths, not host paths. ` +
      `Networking is ${sandbox?.network ?? "on"}. No host fallback or host execution tool exists. ` +
      `If stopped, chat still works but file/shell actions are blocked before execution. Ask the user to run /sandbox start, ` +
      `or /sandbox for runtime switching, saving a default runtime, network and maintenance. Other tools are not sandbox-backed and are blocked. ` +
      `Available development tooling is intentionally minimal. ` +
      `Shell calls default to 120 seconds. Cancelling, timing out, or exceeding the 32 MiB transport limit destroys ` +
      `the container (live project changes survive). Background processes last only as long as the sandbox. ` +
      `Large bash output may be spooled by Pi to a host session temp file; it is not a sandbox path. ` +
      `For large output, redirect it into /workspace and read it in chunks instead.`;
  });
  pi.on("session_start", async (_event, ctx) => {
    stopMetrics();
    sandbox = undefined;
    pi.setActiveTools(TOOLS);
    // Canonicalize the one intentional host mount; never read project-local config.
    const project = await realpath(ctx.cwd);
    const network = pi.getFlag("sandbox-network");
    if (network !== "on" && network !== "off") throw new Error("--sandbox-network must be on or off");
    defaultRuntime = await readDefaultRuntime() ?? "podman";
    const runtime = parseRuntime(pi.getFlag("sandbox-runtime") ?? defaultRuntime);
    const stats = pi.getFlag("sandbox-stats") ?? "on";
    if (stats !== "on" && stats !== "off") throw new Error("--sandbox-stats must be on or off");
    statsEnabled = stats === "on";
    sandbox = new Sandbox(project, String(pi.getFlag("sandbox-image") ?? DEFAULT_IMAGE), network as Network,
      undefined, ctx.sessionManager.getSessionId(), runtime);
    status(ctx);
    // A switch or reload within this process preserves the container; reattach to it
    // instead of making a new one. Only probe the runtime when this process already owns a
    // container for this session, so a plain startup stays side-effect free.
    if (isStarted(sandbox.containerName, sandbox.runtime)) {
      try { await sandbox.adopt(); }
      catch (error) { ctx.ui.notify(`Sandbox reattach blocked: ${error}. Use /sandbox stop before starting again.`, "warning"); }
    }
    if (!sandbox.name && pi.getFlag("sandbox-auto-start")) {
      status(ctx, "Starting sandbox…");
      try { await sandbox.start(); }
      catch (error) { ctx.ui.notify(`Sandbox startup failed; tools blocked: ${error}`, "error"); }
    } else if (!sandbox.name && ctx.hasUI) {
      ctx.ui.notify(`Sandbox stopped (${sandbox.backend.label}). Chat works; agent file/shell actions (read, write, edit, bash), plus !/!! commands, are blocked with no host fallback.\n/sandbox start — enable file/shell actions\n/sandbox — start/stop, switch runtime, save a default runtime, network, build and cleanup\nSaved default runtime: ${defaultRuntime}; --sandbox-runtime overrides it. --sandbox-auto-start enables startup automatically.`, "info");
    }
    status(ctx);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // Only a real exit tears containers down. Session switches and reloads keep this
    // session's container running so returning to it reattaches without a restart, and
    // so other sessions' sandboxes keep running in parallel, undisturbed.
    stopMetrics();
    try {
      if (event.reason === "quit") { try { await sandbox?.stop(); } finally { await stopAll(); } }
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
    description: "Sandbox status; switch/save default runtime, network, build, cleanup; start or stop",
    getArgumentCompletions(prefix) {
      return ["start", "stop"]
        .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the agent to finish before managing its sandbox", "warning"); return; }
      let action = args.trim();
      let saveRuntime = false;
      if (action && action !== "start" && action !== "stop") { ctx.ui.notify(HELP, "info"); return; }
      try {
        const s = get();
        const build = async () => {
          if (!ctx.hasUI || !await ctx.ui.confirm("Build/rebuild sandbox image?",
            `Build ${s.image} in ${s.backend.label}? This can overwrite the selected tag, downloads packages using host-side networking, and may take several minutes.`)) return false;
          status(ctx, `Building shared toolbox image… (host-side ${s.backend.label} build; network required)`);
          await s.backend.build(s.image, fileURLToPath(new URL("../container/", import.meta.url)));
          return true;
        };
        const showStatus = async () => {
          let state = "stopped";
          if (s.name) {
            state = await s.backend.inspect(s.name);
            if (state !== "running") await s.stop();
            else if (statsEnabled && !metricsTarget) await s.refreshMetrics();
          }
          ctx.ui.notify(`Sandbox: ${state}\nRuntime: ${s.backend.label}\nSaved default runtime: ${defaultRuntime} (${settingsPath()}; --sandbox-runtime overrides it)\n${sandboxView(s, undefined, statsEnabled).detail.join("\n")}\nLimits: ${s.backend.limits}${s.startDurationMs === undefined ? "" : `\nLast container launch: ${(s.startDurationMs / 1000).toFixed(2)}s (excludes preflight/build)`}`, "info");
        };
        if (!action) {
          await showStatus();
          if (!ctx.hasUI) return;
          const choice = await ctx.ui.select("Sandbox — manage runtime, network and maintenance", [
            s.name ? "Stop sandbox" : "Start sandbox",
            `Runtime: ${s.backend.label}`,
            `Network: ${s.network}`, "What is blocked?", "Build/rebuild image", "Clean up stopped containers",
          ]);
          if (choice === "Start sandbox") action = "start";
          else if (choice === "Stop sandbox") action = "stop";
          else if (choice === "What is blocked?") {
            ctx.ui.notify("Tools are agent actions: read reads files, write creates/replaces files, edit applies changes, and bash runs shell commands. They execute only in the container; when stopped, calls are rejected before execution, never sent to the host. Other agent tools are blocked because they lack sandbox-backed implementations. User !/!! commands also require the sandbox. Chat and /sandbox management still work. Pi and trusted extensions themselves run on the host; this is not an OS sandbox for Pi.", "info");
            return;
          } else if (choice?.startsWith("Runtime:")) {
            if (s.name) throw new Error("Stop the sandbox before switching runtimes: /sandbox stop. Temporary data will not transfer.");
            const next = await ctx.ui.select("Select runtime (separate image stores; no fallback)", ["podman", "apple"]);
            if (!next) return;
            if (next !== defaultRuntime) {
              const scope = await ctx.ui.select(`Use ${next} — current default: ${defaultRuntime}`, [
                "Just this session", "Use now and set default for all projects",
              ]);
              if (!scope) return;
              saveRuntime = scope === "Use now and set default for all projects";
            }
            action = `runtime ${next}`;
          } else if (choice?.startsWith("Network:")) {
            const next = await ctx.ui.select("Container networking (Pi provider requests stay on host)", ["on", "off"]);
            if (!next || next === s.network) return;
            if (s.name && !await ctx.ui.confirm("Recreate sandbox?", "Changing network discards temporary files and background processes. Live project edits survive.")) return;
            action = `network ${next}`;
          } else if (choice === "Build/rebuild image") action = "build";
          else if (choice === "Clean up stopped containers") action = "cleanup";
          else return;
        }
        const activities: Record<string, string> = {
          start: "Starting sandbox…", stop: "Stopping sandbox…",
          "network on": "Enabling network… (running container will be recreated)",
          "network off": "Disabling network… (running container will be recreated)",
        };
        if (activities[action]) status(ctx, activities[action]);
        if (action === "start") {
          try { await s.start(); }
          catch (error) {
            if (!(error instanceof MissingImageError)) throw error;
            status(ctx);
            if (!await build()) { ctx.ui.notify(error.message, "warning"); return; }
            status(ctx, "Starting sandbox…");
            await s.start();
          }
        } else if (action === "stop") await s.stop();
        else if (action === "build") {
          if (!await build()) return;
        } else if (action === "runtime podman" || action === "runtime apple") {
          const next = parseRuntime(action.split(" ")[1]);
          if (s.runtime !== next) {
            if (s.name) throw new Error("Stop the sandbox before switching runtimes: /sandbox stop. Temporary data will not transfer.");
            await s.stop(); // Retry any failed removal before losing its binding.
            stopMetrics();
            sandbox = new Sandbox(s.project, s.image, s.network, undefined, s.id, next);
          }
          if (saveRuntime) {
            await saveDefaultRuntime(next);
            defaultRuntime = next;
          }
          const scope = next === defaultRuntime
            ? "Default for all projects; future sessions/reloads use it unless --sandbox-runtime is supplied."
            : `Just this session; default for all projects remains ${defaultRuntime}.`;
          ctx.ui.notify(`Runtime: ${get().backend.label}. ${scope} Images are separate per runtime; use /sandbox start to build a missing image with confirmation.`, "info");
        } else if (action === "network on" || action === "network off") {
          const next = action.endsWith(" off") ? "off" : "on";
          if (s.network !== next) {
            const running = !!s.name;
            await s.stop(); s.network = next;
            if (running) await s.start();
          }
        } else if (action === "cleanup") {
          // Never prune images, volumes, active sessions, or unrelated containers.
          const ids = await s.backend.stopped();
          if (!ids.length) { ctx.ui.notify("No stopped pi-sandbox containers to remove", "info"); return; }
          if (!ctx.hasUI || !await ctx.ui.confirm("Remove stopped sandboxes?", `${ids.length} stopped managed container(s). No images or volumes will be deleted.`)) return;
          // No force: a container started since the listing must not be killed.
          for (const id of ids) await s.backend.remove(id, false);
        } else { ctx.ui.notify(HELP, "info"); return; }
        if (action === "stop") ctx.ui.notify("Sandbox stopped. Agent file/shell actions (read, write, edit, bash) and !/!! are blocked; chat still works and nothing switched to host execution. Live project changes are preserved. Use /sandbox start to resume, or /sandbox for runtime switching, saved default runtime and other settings.", "info");
        else if (!action.startsWith("runtime ")) ctx.ui.notify(`Sandbox: ${action} complete`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Sandbox ${action} failed: ${message}`, "error");
      }
      finally { status(ctx); }
    },
  });
}
