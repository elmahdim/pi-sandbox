import assert from "node:assert/strict";
import test from "node:test";
import { sandboxView } from "../src/ui.ts";

test("stopped sandbox removes footer and explicitly blocks host fallback", () => {
  for (const state of [undefined, { project: "/project", network: "on" as const }]) {
    const view = sandboxView(state);
    assert.equal(view.footer, undefined);
    assert.match(view.lines.join("\n"), /SANDBOX OFF.*agent tools blocked.*no host fallback/);
    assert.match(view.lines.join("\n"), /\/sandbox start/);
    assert.equal(view.running, false);
  }
});

test("active indicator describes execution boundary, live mount, image, container and networking", () => {
  const view = sandboxView({ name: "pi-sandbox-test", project: "/my/project", image: "toolbox:1", network: "on" });
  assert.equal(view.footer, "sandbox active · net on · live RW");
  const text = view.lines.join("\n");
  for (const expected of ["SANDBOX ACTIVE", "/my/project → /workspace", "LIVE read-write", "internet / LAN access allowed", "toolbox:1", "pi-sandbox-test", "authentication stay on host"]) {
    assert.ok(text.includes(expected), expected);
  }
});

test("offline networking is clearly distinguished from host provider networking", () => {
  const view = sandboxView({ name: "test", network: "off" });
  assert.match(view.footer!, /net off/);
  assert.match(view.lines.join("\n"), /OFF — external access blocked/);
  assert.match(view.lines.join("\n"), /Pi \+ provider authentication stay on host/);
});

test("progress is visible without claiming a stopped container is active", () => {
  const view = sandboxView(undefined, "Starting sandbox…");
  assert.equal(view.lines[0], "Starting sandbox…");
  assert.equal(view.footer, undefined);
  assert.equal(view.running, false);
});
