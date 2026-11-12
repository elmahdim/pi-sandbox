import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../src/runtime.ts";

test("real Apple Container: live writes, hardening, offline networking, stats, timeout cleanup", {
  skip: process.env.PI_SANDBOX_APPLE_INTEGRATION !== "1", timeout: 90_000,
}, async () => {
  assert.equal(process.platform, "darwin", "Run this test on an Apple Silicon Mac with container installed");
  const project = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-apple-test-")));
  const s = new Sandbox(project, process.env.PI_SANDBOX_TEST_IMAGE, "off", undefined, undefined, "apple");
  try {
    await s.start();
    assert.equal(await s.backend.inspect(s.name!), "running");
    const filename = "quote ' dollar $ file.txt";
    const content = "literal $(echo not-executed)\nsecond line\n";
    await s.file(["sh", "-c", 'cat > "$1"', "write", `/workspace/${filename}`], { input: content });
    assert.equal(await readFile(join(project, filename), "utf8"), content);
    assert.equal((await s.file(["cat", "--", `/workspace/${filename}`])).toString(), content);
    assert.notEqual((await s.exec(["sh", "-c", "touch /must-not-write"])).code, 0);
    const process = (await s.file(["cat", "/proc/self/status"])).toString();
    assert.match(process, /NoNewPrivs:\s+1/);
    assert.match(process, /CapEff:\s+0+\s/);
    assert.equal((await s.file(["bash", "-c", "ulimit -u"])).toString().trim(), "256");
    // No non-loopback interfaces when --network none is applied.
    const interfaces = (await s.file(["sh", "-c", "ls /sys/class/net"])).toString().trim();
    assert.equal(interfaces, "lo");
    await s.refreshMetrics();
    assert.equal(s.metricsState, "available");
    assert.ok(s.metrics?.memoryBytes !== undefined);
    await assert.rejects(s.exec(["sleep", "600"], { timeoutMs: 300 }), /timed out/);
    assert.equal(s.name, undefined);
    assert.notEqual(await s.backend.inspect(s.containerName), "running");
    assert.equal(await readFile(join(project, filename), "utf8"), content);
  } finally { await s.stop(); await rm(project, { recursive: true, force: true }); }
});
