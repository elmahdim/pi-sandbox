import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDefaultRuntime, settingsPath } from "../src/settings.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { Sandbox } from "../src/runtime.ts";
import { MissingImageError } from "../src/backends.ts";

// Never read or change the developer's saved runtime during tests.
const agentDir = mkdtempSync(join(tmpdir(), "pi-sandbox-extension-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function harness() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const commands = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerFlag: (name: string, options: any) => flags.set(name, options.default),
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: Function) => handlers.set(event, handler),
    setActiveTools: (names: string[]) => { active = names; },
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  extension(pi as unknown as ExtensionAPI);
  return { handlers, tools, flags, commands, active: () => active };
}
const sessionManager = { getSessionId: () => "test-session" };
const ctx = () => ({ cwd: process.cwd(), hasUI: false, sessionManager, ui: { setStatus() {}, notify() {} } });

test("only four sandbox-backed tools are registered; stopped calls fail closed", async () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()].sort(), ["bash", "edit", "read", "write"]);
  await h.handlers.get("session_start")!({}, ctx());
  assert.deepEqual(h.active(), ["read", "write", "edit", "bash"]);
  for (const name of ["read", "write", "edit", "bash", "powershell", "grep", "codemode", "mcp__host"]) {
    assert.equal(h.handlers.get("tool_call")!({ toolName: name }).block, true);
  }
  // Even direct execute calls cannot accidentally use builtin host I/O.
  await assert.rejects(h.tools.get("read").execute("id", { path: "package.json" }, undefined, undefined, ctx()), /Sandbox stopped/);
});

test("user ! and !! never fall through to host execution", async () => {
  const h = harness();
  const result = h.handlers.get("user_bash")!({ command: "echo unsafe", excludeFromContext: true }, ctx());
  assert.ok(result.operations);
  await assert.rejects(result.operations.exec("echo unsafe", "/workspace", { onData() {} }), /not initialized/);
});

test("stop clears sandbox footer, shows OFF boundary indicator; shutdown clears all sandbox UI", async () => {
  const h = harness();
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const notifications: string[] = [];
  const context = {
    cwd: process.cwd(), hasUI: true, isIdle: () => true, sessionManager,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      setWidget: (_key: string, value: string[] | undefined) => widgets.push(value),
      notify: (text: string) => notifications.push(text),
    },
  };
  await h.handlers.get("session_start")!({}, context);
  assert.equal(statuses.at(-1), undefined);
  await h.commands.get("sandbox").handler("stop", context);
  assert.equal(statuses.at(-1), undefined);
  assert.match(widgets.at(-1)!.join("\n"), /🔓 Sandbox off.*tools blocked.*\/sandbox start/);
  assert.match(notifications.at(-1)!, /nothing switched to host execution/);
  await h.handlers.get("session_shutdown")!({}, context);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
});

test("TUI widget uses a responsive component and leaves the footer untouched", async () => {
  const h = harness();
  let factory: any;
  const theme = { fg: (_color: string, text: string) => text };
  const context = {
    ...ctx(), mode: "tui", hasUI: true,
    ui: {
      theme, setStatus() {}, notify() {},
      setWidget: (_key: string, value: any) => { factory = value; },
    },
  };
  await h.handlers.get("session_start")!({}, context);
  assert.equal(typeof factory, "function");
  const component = factory({}, theme);
  assert.match(component.render(100)[0], /🔓 Sandbox off.*tools blocked.*\/sandbox start.*\/sandbox for settings +Podman$/);
  assert.match(component.render(48)[0], /Tools blocked.*\/sandbox start.*\/sandbox/);
  component.invalidate();
  await h.handlers.get("session_shutdown")!({}, context);
  assert.equal(factory, undefined);
});

test("invalid network fails closed; prompt uses sandbox cwd", async () => {
  const h = harness();
  h.flags.set("sandbox-network", "host");
  await assert.rejects(h.handlers.get("session_start")!({}, ctx()), /must be on or off/);
  const event = { systemPromptOptions: { cwd: "/host", sections: {} as Record<string, string> } };
  h.handlers.get("before_agent_start")!(event);
  assert.equal(event.systemPromptOptions.cwd, "/workspace");
  assert.match(event.systemPromptOptions.sections.sandbox, /No host fallback/);
});

test("runtime and metrics flags default safely and reject invalid values without enabling tools", async () => {
  const h = harness();
  assert.equal(h.flags.get("sandbox-runtime"), undefined);
  assert.equal(h.flags.get("sandbox-stats"), "on");
  assert.equal(h.flags.get("sandbox-auto-start"), false);
  h.flags.set("sandbox-runtime", "auto");
  await assert.rejects(h.handlers.get("session_start")!({}, ctx()), /must be podman or apple/);
  assert.equal(h.handlers.get("tool_call")!({ toolName: "bash" }).block, true);
  h.flags.set("sandbox-runtime", "apple");
  h.flags.set("sandbox-stats", "invalid");
  await assert.rejects(h.handlers.get("session_start")!({}, ctx()), /sandbox-stats must be on or off/);
});

test("selecting Apple at startup changes prompt/status but never starts it implicitly", async () => {
  const h = harness();
  const notifications: string[] = [];
  h.flags.set("sandbox-runtime", "apple");
  h.flags.set("sandbox-stats", "off");
  const context = { ...ctx(), isIdle: () => true, ui: { notify: (s: string) => notifications.push(s) } };
  await h.handlers.get("session_start")!({}, context);
  const event = { systemPromptOptions: { cwd: "/host", sections: {} as Record<string, string> } };
  h.handlers.get("before_agent_start")!(event);
  assert.match(event.systemPromptOptions.sections.sandbox, /Apple Container/);
  await h.commands.get("sandbox").handler("", context);
  assert.match(notifications.at(-1)!, /Sandbox: stopped\nRuntime: Apple Container/);
  assert.equal(h.handlers.get("tool_call")!({ toolName: "bash" }).block, true);
  await h.handlers.get("session_shutdown")!({ reason: "quit" }, context);
});

function menuContext(choices: Array<string | undefined> = [], confirmations: boolean[] = []) {
  const notifications: string[] = [], prompts: string[] = [];
  return {
    ...ctx(), hasUI: true, isIdle: () => true, notifications, prompts,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {}, setWidget() {},
      notify: (text: string) => notifications.push(text),
      select: async (title: string, options: string[]) => {
        prompts.push(title);
        const choice = choices.shift();
        if (choice !== undefined) assert.ok(options.includes(choice), `Missing option: ${choice}`);
        return choice;
      },
      confirm: async (title: string) => { prompts.push(title); return confirmations.shift() ?? false; },
    },
  };
}

test("only start/stop are completed; runtime switching lives in the session-local menu", async () => {
  const h = harness();
  const context = menuContext(["Runtime: Podman", "apple", "Just this session", "Runtime: Apple Container", "podman"]);
  await h.handlers.get("session_start")!({}, context);
  const command = h.commands.get("sandbox");
  assert.deepEqual(command.getArgumentCompletions("").map((c: any) => c.value), ["start", "stop"]);
  assert.deepEqual(command.getArgumentCompletions("st").map((c: any) => c.value), ["start", "stop"]);
  await command.handler("", context);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  h.handlers.get("before_agent_start")!(event);
  assert.match(event.systemPromptOptions.sections.sandbox, /Apple Container/);
  assert.equal(await readDefaultRuntime(), undefined);
  assert.equal(h.flags.get("sandbox-runtime"), undefined);
  await command.handler("", context);
  h.handlers.get("before_agent_start")!(event);
  assert.match(event.systemPromptOptions.sections.sandbox, /Podman/);
  await command.handler("build", context);
  assert.match(context.notifications.at(-1)!, /Usage:/);
  await h.handlers.get("session_shutdown")!({ reason: "quit" }, context);
});

test("menu cancellation and headless status do not change settings or prompt", async () => {
  const h = harness(), context = menuContext();
  await h.handlers.get("session_start")!({}, context);
  await h.commands.get("sandbox").handler("", context);
  assert.match(context.notifications.at(-1)!, /Sandbox: stopped/);
  const headless = { ...context, hasUI: false };
  await h.commands.get("sandbox").handler("", headless);
  assert.equal(context.prompts.length, 1);
  assert.equal(h.handlers.get("tool_call")!({ toolName: "bash" }).block, true);
});

test("missing image build requires confirmation, retries start only after successful build", async (t) => {
  const h = harness(), context = menuContext([], [false, true]);
  let starts = 0, builds = 0;
  t.mock.method(Sandbox.prototype, "start", async function(this: Sandbox) {
    this.backend.build = async () => { builds++; };
    starts++;
    if (!builds) throw new MissingImageError(this.image);
  });
  await h.handlers.get("session_start")!({}, context);
  const command = h.commands.get("sandbox");
  await command.handler("start", context);
  assert.equal(builds, 0);
  assert.equal(starts, 1);
  await command.handler("start", context);
  assert.equal(builds, 1);
  assert.equal(starts, 3);
  assert.equal(context.prompts.filter(p => p === "Build/rebuild sandbox image?").length, 2);
});

test("running runtime switch is refused and network recreation requires confirmation", async (t) => {
  const h = harness(), context = menuContext(["Runtime: Podman", "Network: on", "off", "Network: on", "off"], [false, true]);
  let starts = 0, stops = 0;
  t.mock.method(Sandbox.prototype, "start", async function(this: Sandbox) {
    starts++; this.name = "test-running";
    this.backend.inspect = async () => "running";
  });
  t.mock.method(Sandbox.prototype, "stop", async function(this: Sandbox) { stops++; this.name = undefined; });
  h.flags.set("sandbox-stats", "off");
  await h.handlers.get("session_start")!({}, context);
  const command = h.commands.get("sandbox");
  await command.handler("start", context);
  await command.handler("", context);
  assert.match(context.notifications.at(-1)!, /Stop the sandbox before switching/);
  await command.handler("", context);
  assert.equal(stops, 0);
  await command.handler("", context);
  assert.equal(stops, 1);
  assert.equal(starts, 2);
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  h.handlers.get("before_agent_start")!(event);
  assert.match(event.systemPromptOptions.sections.sandbox, /Networking is off/);
  await command.handler("stop", context);
});

test("maintenance builds and cleanup require confirmation and cleanup never forces removal", async (t) => {
  const h = harness(), context = menuContext(["Build/rebuild image", "Build/rebuild image", "Clean up stopped containers", "Clean up stopped containers"], [false, true, false, true]);
  let builds = 0;
  const removals: Array<[string, boolean | undefined]> = [];
  t.mock.method(Sandbox.prototype, "start", async function(this: Sandbox) {
    this.backend.build = async () => { builds++; };
    this.backend.stopped = async () => ["stopped-managed"];
    this.backend.remove = async (id, force) => { removals.push([id, force]); };
  });
  await h.handlers.get("session_start")!({}, context);
  const command = h.commands.get("sandbox");
  await command.handler("start", context);
  await command.handler("", context);
  assert.equal(builds, 0);
  await command.handler("", context);
  assert.equal(builds, 1);
  await command.handler("", context);
  assert.deepEqual(removals, []);
  await command.handler("", context);
  assert.deepEqual(removals, [["stopped-managed", false]]);
});

test("headless missing images and unrelated startup failures never build", async (t) => {
  const h = harness(), context = menuContext([], [true]);
  let builds = 0;
  t.mock.method(Sandbox.prototype, "start", async function(this: Sandbox) {
    this.backend.build = async () => { builds++; };
    throw new MissingImageError(this.image);
  });
  await h.handlers.get("session_start")!({}, context);
  await h.commands.get("sandbox").handler("start", { ...context, hasUI: false });
  assert.equal(context.prompts.length, 0);
  t.mock.method(Sandbox.prototype, "start", async () => { throw new Error("Runtime unavailable"); });
  await h.commands.get("sandbox").handler("start", context);
  assert.equal(builds, 0);
  assert.equal(context.prompts.length, 0);
  assert.match(context.notifications.at(-1)!, /Runtime unavailable/);
});

test("stopped guidance defines tools and exposes runtime/default settings", async () => {
  const h = harness(), context = menuContext(["What is blocked?"]);
  await h.handlers.get("session_start")!({}, context);
  const startup = context.notifications.at(-1)!;
  for (const text of ["Chat works", "read, write, edit, bash", "/sandbox start", "switch runtime", "save a default runtime", "--sandbox-auto-start"]) {
    assert.ok(startup.includes(text), text);
  }
  const blocked = h.handlers.get("tool_call")!({ toolName: "bash" });
  assert.match(blocked.reason, /blocked before execution/);
  assert.match(blocked.reason, /save a default runtime/);
  await h.commands.get("sandbox").handler("", context);
  assert.match(context.notifications.at(-1)!, /this is not an OS sandbox for Pi/);
});

test("menu can start the sandbox without memorizing the subcommand", async (t) => {
  let starts = 0;
  t.mock.method(Sandbox.prototype, "start", async () => { starts++; });
  const h = harness(), context = menuContext(["Start sandbox"]);
  await h.handlers.get("session_start")!({}, context);
  await h.commands.get("sandbox").handler("", context);
  assert.equal(starts, 1);
});

test("Runtime switches now and can save the default across projects; CLI overrides it", async () => {
  const h = harness(), context = menuContext(["Runtime: Podman", "apple", "Use now and set default for all projects"]);
  try {
    await h.handlers.get("session_start")!({}, context);
    await h.commands.get("sandbox").handler("", context);
    assert.equal(await readDefaultRuntime(), "apple");
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    h.handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.sandbox, /Apple Container/);
    const fresh = harness();
    await fresh.handlers.get("session_start")!({}, ctx());
    fresh.handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.sandbox, /Apple Container/);
    fresh.flags.set("sandbox-runtime", "podman");
    await fresh.handlers.get("session_start")!({}, ctx());
    fresh.handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.sandbox, /Podman/);
    assert.equal(fresh.handlers.get("tool_call")!({ toolName: "bash" }).block, true);
  } finally { rmSync(settingsPath(), { force: true }); }
});

test("current session runtime can be made the default without switching again", async () => {
  const h = harness(), context = menuContext([
    "Runtime: Podman", "apple", "Just this session",
    "Runtime: Apple Container", "apple", "Use now and set default for all projects",
    "Runtime: Apple Container", "apple",
  ]);
  try {
    await h.handlers.get("session_start")!({}, context);
    const command = h.commands.get("sandbox");
    await command.handler("", context);
    assert.equal(await readDefaultRuntime(), undefined);
    await command.handler("", context);
    assert.equal(await readDefaultRuntime(), "apple");
    const promptsBefore = context.prompts.length;
    await command.handler("", context);
    assert.equal(context.prompts.length - promptsBefore, 2, "existing default skips scope prompt");
  } finally { rmSync(settingsPath(), { force: true }); }
});

test("cancelling runtime or scope selection changes neither runtime nor settings", async () => {
  for (const choices of [["Runtime: Podman", undefined], ["Runtime: Podman", "apple", undefined]]) {
    const h = harness(), context = menuContext(choices);
    await h.handlers.get("session_start")!({}, context);
    await h.commands.get("sandbox").handler("", context);
    assert.equal(await readDefaultRuntime(), undefined);
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    h.handlers.get("before_agent_start")!(event);
    assert.match(event.systemPromptOptions.sections.sandbox, /Podman/);
  }
});
