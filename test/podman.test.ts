import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, runPodman, checked } from "../src/runtime.ts";

test("real Podman: live writes, hardening, offline networking, cancellation", {
  skip: process.env.PI_SANDBOX_INTEGRATION !== "1", timeout: 90_000,
}, async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-test-")));
  const s = new Sandbox(project, process.env.PI_SANDBOX_TEST_IMAGE, "off");
  try {
    await s.start();
    const config = JSON.parse(checked(await runPodman(["inspect", s.name!])).toString())[0];
    assert.equal(config.HostConfig.NetworkMode, "none");
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    const mounts = config.Mounts.filter((m: any) => m.Type === "bind");
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].Destination, "/workspace");
    const filename = "quote ' dollar $ file.txt";
    const content = "literal $(echo not-executed)\nsecond line\n";
    await s.file(["sh", "-c", 'cat > "$1"', "write", `/workspace/${filename}`], { input: content });
    assert.equal(await readFile(join(project, filename), "utf8"), content);
    assert.equal((await s.file(["cat", "--", `/workspace/${filename}`])).toString(), content);
    assert.notEqual((await s.exec(["sh", "-c", "touch /root/must-not-write"])).code, 0);
    const name = s.name!;
    await assert.rejects(s.exec(["sleep", "600"], { timeoutMs: 300 }), /timed out/);
    assert.equal(s.name, undefined);
    assert.notEqual((await runPodman(["container", "exists", name])).code, 0);
    assert.equal(await readFile(join(project, filename), "utf8"), content);
  } finally { await s.stop(); await rm(project, { recursive: true, force: true }); }
});
