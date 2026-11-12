import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sandboxView, spinnerLine, SPINNER_FRAMES, resourceLine } from "../src/ui.ts";

test("stopped sandbox explicitly blocks host fallback", () => {
  for (const state of [undefined, { project: "/project", network: "on" as const }]) {
    const view = sandboxView(state);
    assert.match(view.detail.join("\n"), /SANDBOX OFF.*agent tools blocked.*no host fallback/);
    assert.match(view.detail.join("\n"), /\/sandbox start/);
    assert.match(view.detail.join("\n"), /read, write, edit, bash/);
    assert.match(view.detail.join("\n"), /Chat works/);
    assert.match(view.detail.join("\n"), /save a default runtime/);
    assert.match(view.widget, /\/sandbox for settings/);
    assert.match(view.widget, /🔓 Sandbox off · tools blocked · \/sandbox start/);
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
  assert.match(view.widget, /🔒 Tools isolated in Podman  net on · \/workspace rw · stats pending/);
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

test("indicator shows runtime, actual CPU and memory usage, not just configured limits", () => {
  const view = sandboxView({ name: "test", runtime: "apple", network: "off", metrics: {
    cpuPercent: 123.45, memoryBytes: 32 * 1024 ** 2, memoryLimitBytes: 1024 ** 3, pids: 6, sampledAt: Date.now(),
  } });
  assert.match(view.widget, /🔒 Tools isolated in Apple Container  net off · \/workspace rw · cpu 123.5% · mem 32 MiB/);
  assert.match(view.detail.join("\n"), /Apple Container/);
  assert.match(view.detail.join("\n"), /6 processes/);
  assert.match(view.detail.join("\n"), /excludes total host\/VM overhead/);
});

test("responsive bar right-aligns details and drops metrics before boundary information", () => {
  const view = sandboxView({ name: "test", runtime: "apple", network: "off", metrics: {
    cpuPercent: 2.4, memoryBytes: 128 * 1024 ** 2, sampledAt: 0,
  } });
  const wide = view.renderWidget(120);
  assert.equal(visibleWidth(wide), 120);
  assert.match(wide, /Apple Container {2,}net off · \/workspace rw · cpu 2.4% · mem 128 MiB$/);
  const narrow = view.renderWidget(65);
  assert.match(narrow, /net off · \/workspace rw$/);
  assert.ok(!narrow.includes("cpu"));
  for (let width = 0; width <= 150; width++) {
    for (const v of [view, sandboxView(undefined), sandboxView(undefined, "◳ Starting sandbox…")]) {
      assert.ok(visibleWidth(v.renderWidget(width)) <= width, `width ${width}`);
    }
  }
  const stopped = sandboxView({ runtime: "apple" });
  assert.match(stopped.renderWidget(80), /🔓 Tools blocked · \/sandbox start · \/sandbox +Apple Container$/);
  assert.match(stopped.renderWidget(48), /Tools blocked · \/sandbox start · \/sandbox/);
});

test("absent metrics are pending/unavailable/off, never a fabricated zero", () => {
  assert.equal(resourceLine({}), "stats pending");
  assert.equal(resourceLine({ metricsState: "unavailable" }), "stats unavailable");
  assert.equal(resourceLine({}, false), "stats off");
  assert.equal(resourceLine({ metrics: { memoryBytes: 0, sampledAt: 0 } }), "cpu — · mem 0 MiB/—");
  assert.ok(!sandboxView({ runtime: "apple" }).widget.includes("cpu"));
});
