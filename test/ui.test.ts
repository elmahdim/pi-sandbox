import assert from "node:assert/strict";
import test from "node:test";
import { sandboxView, spinnerLine, SPINNER_FRAMES } from "../src/ui.ts";

test("stopped sandbox explicitly blocks host fallback", () => {
  for (const state of [undefined, { project: "/project", network: "on" as const }]) {
    const view = sandboxView(state);
    assert.match(view.detail.join("\n"), /SANDBOX OFF.*agent tools blocked.*no host fallback/);
    assert.match(view.detail.join("\n"), /\/sandbox start/);
    assert.match(view.widget, /📦 sandbox offline.*tools locked.*no host fallback.*\/sandbox start/);
    assert.equal(view.running, false);
  }
});

test("active indicator describes execution boundary, live mount, image, container and networking", () => {
  const view = sandboxView({ name: "pi-sandbox-test", project: "/my/project", image: "toolbox:1", network: "on" });
  const text = view.detail.join("\n");
  for (const expected of ["SANDBOX ACTIVE", "/my/project → /workspace", "agent-isolated read-write", "internet / LAN access allowed", "toolbox:1", "pi-sandbox-test", "authentication stay on host"]) {
    assert.ok(text.includes(expected), expected);
  }
  // The above-editor widget collapses to a single informative line.
  assert.match(view.widget, /📦 sandbox online · net on · rw · agent-isolated/);
});

test("offline networking is clearly distinguished from host provider networking", () => {
  const view = sandboxView({ name: "test", network: "off" });
  assert.match(view.detail.join("\n"), /OFF — external access blocked/);
  assert.match(view.widget, /net off/);
  assert.match(view.detail.join("\n"), /Pi \+ provider authentication stay on host/);
});

test("progress is visible without claiming a stopped container is active", () => {
  const view = sandboxView(undefined, "Starting sandbox…");
  assert.equal(view.widget, "Starting sandbox…");
  assert.equal(view.running, false);
});

test("spinner line animates a rotating cube with each frame", () => {
  for (let i = 0; i < SPINNER_FRAMES.length * 2; i++) {
    assert.equal(spinnerLine(i, "Starting sandbox…"), `${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} Starting sandbox…`);
  }
});
