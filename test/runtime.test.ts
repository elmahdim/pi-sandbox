import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { Sandbox, containerPath, runArgs, checked, type Runner, type RunResult } from "../src/runtime.ts";

const ok = (text = ""): RunResult => ({ stdout: Buffer.from(text), stderr: Buffer.alloc(0), code: 0 });

test("map only exact project prefix; outside paths stay container paths", () => {
  assert.equal(containerPath("/projects/app", "/projects/app"), "/workspace");
  assert.equal(containerPath("/projects/app/a b.ts", "/projects/app"), "/workspace/a b.ts");
  assert.equal(containerPath("/projects/app-other/file", "/projects/app"), "/projects/app-other/file");
  assert.equal(containerPath("/etc/passwd", "/projects/app"), "/etc/passwd");
  assert.equal(containerPath("/projects/app/../secret", "/projects/app"), "/projects/app/../secret");
});

test("container has only project mount, resource limits, no credentials or socket", () => {
  const args = runArgs("test", "/projects/a space", "localhost/test:1", "off");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args.filter((arg) => arg === "--mount").length, 1);
  assert.ok(args.includes("type=bind,source=/projects/a space,target=/workspace"));
  for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--userns=keep-id", "--rm", "--pull=never"]) assert.ok(args.includes(flag));
  assert.ok(!args.some((arg) => /docker.sock|podman.sock|\.ssh|auth.json|--privileged/.test(arg)));
  assert.equal(runArgs("test", "/project", "image", "on")[runArgs("test", "/project", "image", "on").indexOf("--network") + 1], "bridge");
});

test("reject dangerous mount roots and ambiguous mount syntax", () => {
  for (const path of ["/", homedir(), "/a,b", "/a:b", "/a\nb"]) {
    assert.throws(() => runArgs("test", path, "image", "off"));
  }
  assert.throws(() => runArgs("test", "/project", "--privileged", "off"));
});

test("stopped sandbox never invokes Podman exec or a local shell", async () => {
  let called = false;
  const s = new Sandbox("/project", "image", "off", async () => { called = true; return ok(); });
  await assert.rejects(s.exec(["bash", "-c", "echo test"]), /Host fallback is disabled/);
  assert.equal(called, false);
});

test("start is reusable; argv and stdin are transported literally; stop is idempotent", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (args, options) => {
    calls.push(args);
    if (args[0] === "exec") assert.equal(options?.input, "$(touch /host-owned)\n'\"\u0000");
    return ok("result");
  };
  const s = new Sandbox("/project", "image", "off", runner);
  await s.start(); const name = s.name;
  await s.start(); assert.equal(s.name, name); assert.equal(calls.length, 1);
  await s.file(["sh", "-c", 'cat > "$1"', "write", "/workspace/a $(x)"], { input: "$(touch /host-owned)\n'\"\u0000" });
  assert.deepEqual(calls[1].slice(-5), ["sh", "-c", 'cat > "$1"', "write", "/workspace/a $(x)"]);
  await s.stop(); await s.stop();
  assert.equal(calls.filter((args) => args[0] === "rm").length, 1);
  assert.equal(s.name, undefined);
});

test("start failure attempts removal and remains blocked", async () => {
  const calls: string[][] = [];
  const s = new Sandbox("/project", "image", "off", async (args) => {
    calls.push(args);
    if (args[0] === "run") return { ...ok(), code: 125, stderr: Buffer.from("missing image") };
    return ok();
  });
  await assert.rejects(s.start(), /missing image/);
  assert.equal(s.name, undefined);
  assert.equal(calls[1][0], "rm");
});

test("missing image gives build instructions, without auto-pulling or executing locally", async () => {
  const s = new Sandbox("/project", "localhost/pi-sandbox:0.1", "off", async (args) => {
    return args[0] === "run"
      ? { ...ok(), code: 125, stderr: Buffer.from("Error: localhost/pi-sandbox:0.1: image not known") }
      : ok();
  });
  await assert.rejects(s.start(), /Run \/sandbox build, then \/sandbox start/);
  assert.equal(s.name, undefined);
});

test("transport failure / cancellation removes entire sandbox, even with concurrent operations", async () => {
  const calls: string[][] = [];
  const s = new Sandbox("/project", "image", "off", async (args) => {
    calls.push(args);
    if (args[0] === "exec") throw new Error("Cancelled");
    return ok();
  });
  await s.start();
  await assert.rejects(s.exec(["sleep", "600"]), /Cancelled/);
  assert.equal(s.name, undefined);
  assert.equal(calls.at(-1)?.[0], "rm");
  await assert.rejects(s.exec(["echo", "no"]), /Host fallback/);
});

test("failed removal is remembered for retry but execution stays blocked", async () => {
  let removals = 0;
  const s = new Sandbox("/project", "image", "off", async (args) => {
    if (args[0] === "rm" && ++removals === 1) throw new Error("unavailable");
    return ok();
  });
  await s.start(); await assert.rejects(s.stop());
  assert.equal(s.name, undefined);
  await s.stop(); assert.equal(removals, 2);
});

test("nonzero command exit is returned without destroying sandbox", async () => {
  const s = new Sandbox("/project", "image", "off", async (args) => args[0] === "exec" ? { ...ok(), code: 42 } : ok());
  await s.start();
  assert.equal((await s.exec(["false"])).code, 42);
  assert.ok(s.name);
  await assert.rejects(s.file(["false"]), /42/);
  assert.throws(() => checked({ ...ok(), code: 1 }), /Podman failed/);
});
