import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

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
  assert.match(widgets.at(-1)!.join("\n"), /SANDBOX OFF.*no host fallback/);
  assert.match(notifications.at(-1)!, /nothing switched to host execution/);
  await h.handlers.get("session_shutdown")!({}, context);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
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
