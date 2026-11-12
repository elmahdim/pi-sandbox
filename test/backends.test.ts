import assert from "node:assert/strict";
import test from "node:test";
import { appleRunArgs, createBackend, parseRuntime, parseBytes, parseAppleStats, parsePodmanStats } from "../src/backends.ts";
import { Sandbox, isStarted, stopAll, type Runner, type RunResult } from "../src/runtime.ts";

const ok = (text = ""): RunResult => ({ stdout: Buffer.from(text), stderr: Buffer.alloc(0), code: 0 });
const fail = (text: string): RunResult => ({ ...ok(), stderr: Buffer.from(text), code: 1 });
const help = "--read-only --cap-drop --tmpfs --ulimit";
const config = { name: "pi-sandbox-apple-unit", project: "/project", image: "localhost/test:1", network: "off" as const };

// CLI and JSON fixtures follow apple/container tag 1.7.1, not Docker/Podman shapes.
test("runtime selection is explicit and validates values", () => {
  assert.equal(parseRuntime("podman"), "podman");
  assert.equal(parseRuntime("apple"), "apple");
  for (const bad of ["container", "docker", "auto", "", undefined, "--privileged"]) assert.throws(() => parseRuntime(bad));
});

test("Apple args use its own hardening, user, network and no extra host mounts", () => {
  const args = appleRunArgs(config);
  for (const flag of ["--read-only", "--cap-drop", "ALL", "--ulimit", "nproc=256:256", "--user", "--no-new-privs"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args.filter((x) => x === "--mount").length, 1);
  assert.ok(args.includes("type=bind,source=/project,target=/workspace"));
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,size=256m,mode=1777"));
  assert.ok(!args.some((x) => /--replace|--pull|--userns|--privileged|--ssh|sock|--env-file/.test(x)));
  assert.equal(appleRunArgs({ ...config, network: "on" })[args.indexOf("--network") + 1], "default");
  assert.throws(() => appleRunArgs({ ...config, project: "/" }));
  assert.throws(() => appleRunArgs({ ...config, image: "--privileged" }));
  assert.throws(() => appleRunArgs({ ...config, name: "--all" }));
});

test("Apple preflight refuses missing hardening or image before running anything", async () => {
  const calls: string[][] = [];
  let mode = "old";
  const runner: Runner = async (args) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "--help") return ok(mode === "old" ? "--read-only" : help);
    if (args[0] === "image") return fail("not found");
    return ok();
  };
  const s = new Sandbox("/project", "image", "off", runner, "preflight", "apple");
  await assert.rejects(s.start(), /lacks --cap-drop/);
  mode = "new";
  await assert.rejects(s.start(), /Open \/sandbox and choose Build\/rebuild image/);
  assert.equal(s.name, undefined);
  assert.ok(!calls.some((a) => a[0] === "delete" || (a[0] === "run" && a[1] !== "--help")));
});

test("Apple start, literal stdin/argv transport, reattach, build and stop use only selected backend", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (args, options) => {
    calls.push(args);
    if (args[1] === "--help") return ok(help);
    if (args[0] === "inspect") return ok(JSON.stringify([{ configuration: { id: "pi-sandbox-apple-session" }, status: "running" }]));
    if (args[0] === "exec") assert.equal(options?.input, "$(touch /host)\n'");
    return ok("result");
  };
  const s = new Sandbox("/project", "image", "off", runner, "session", "apple");
  await s.start();
  await s.start();
  assert.ok(s.startDurationMs! >= 0);
  assert.equal(calls.filter((a) => a[0] === "run" && a[1] !== "--help").length, 1);
  assert.deepEqual(calls.find((a) => a[0] === "delete"), ["delete", s.containerName]); // No force on replacement.
  await s.file(["cat", "--", "/workspace/a $(x)"], { input: "$(touch /host)\n'" });
  const exec = calls.find((a) => a[0] === "exec")!;
  assert.ok(exec.includes("--no-new-privs"));
  assert.deepEqual(exec.slice(-3), ["cat", "--", "/workspace/a $(x)"]);
  s.detach();
  const resumed = new Sandbox("/project", "image", "off", runner, "session", "apple");
  assert.equal(await resumed.adopt(), true);
  assert.equal(isStarted(resumed.containerName, "apple"), true);
  assert.equal(isStarted(resumed.containerName, "podman"), false);
  await resumed.backend.build("image", "/context/");
  assert.deepEqual(calls.at(-1), ["build", "--tag", "image", "--file", "/context/Containerfile", "/context/"]);
  await resumed.stop();
  assert.deepEqual(calls.at(-1), ["delete", "--force", resumed.containerName]);
});

test("Apple name collision fails without force-deleting the other running container", async () => {
  const calls: string[][] = [];
  const s = new Sandbox("/project", "image", "off", async (args) => {
    calls.push(args);
    if (args[1] === "--help") return ok(help);
    if (args[0] === "delete") return fail("container is running");
    return ok();
  }, "collision", "apple");
  await assert.rejects(s.start(), /container is running/);
  assert.equal(s.name, undefined);
  assert.ok(!calls.some((a) => a.includes("--force")));
});

test("Apple transport failure destroys the sandbox, metrics failure does not", async () => {
  const calls: string[][] = [];
  const s = new Sandbox("/project", "image", "on", async (args) => {
    calls.push(args);
    if (args[1] === "--help") return ok(help);
    if (args[0] === "stats" || args[0] === "exec") throw new Error("timed out");
    return ok();
  }, "transport", "apple");
  await s.start();
  await s.refreshMetrics();
  assert.ok(s.name);
  assert.equal(s.metricsState, "unavailable");
  await assert.rejects(s.exec(["sleep", "99"]), /timed out/);
  assert.equal(s.name, undefined);
  assert.deepEqual(calls.at(-1), ["delete", "--force", s.containerName]);
  await assert.rejects(s.exec(["echo", "no"]), /Host fallback/);
});

test("cleanup selects only stopped managed Apple containers and never force-deletes", async () => {
  const calls: string[][] = [];
  const row = (id: string, status: string, managed = "1") => ({ configuration: { id, labels: { "io.pi-sandbox.managed": managed } }, status });
  const b = createBackend("apple", async (args) => {
    calls.push(args);
    if (args[0] === "list") return ok(JSON.stringify([
      row("stopped", "stopped"), row("active", "running"), row("other", "stopped", "0"), row("--all", "stopped"),
    ]));
    return ok();
  });
  const ids = await b.stopped();
  assert.deepEqual(ids, ["stopped"]);
  await b.remove(ids[0], false);
  assert.deepEqual(calls.at(-1), ["delete", "stopped"]);
});

test("quit cleanup remembers the correct runner for every runtime", async () => {
  const podman: string[][] = [], apple: string[][] = [];
  const p = new Sandbox("/project", "image", "off", async (a) => { podman.push(a); return ok(); }, "mixed");
  const a = new Sandbox("/project", "image", "off", async (a) => { apple.push(a); return ok(a[1] === "--help" ? help : ""); }, "mixed", "apple");
  await p.start(); await a.start();
  p.detach(); a.detach();
  await stopAll();
  assert.deepEqual(podman.at(-1), ["rm", "--force", "--ignore", p.containerName]);
  assert.deepEqual(apple.at(-1), ["delete", "--force", a.containerName]);
});

test("reattach refuses changed project, image or networking", async () => {
  const runner: Runner = async () => ok("true");
  const s = new Sandbox("/project", "image", "on", runner, "config-change");
  await s.start(); s.detach();
  for (const [project, image, network] of [["/other", "image", "on"], ["/project", "other", "on"], ["/project", "image", "off"]] as const) {
    await assert.rejects(new Sandbox(project, image, network, runner, "config-change").adopt(), /configuration changed/);
  }
  await stopAll(runner);
});

test("stats parsers normalize units and one-core CPU percentages without inventing absent values", () => {
  const podman = parsePodmanStats("150.25%|32MiB / 1GiB|6\n");
  assert.equal(podman.cpuPercent, 150.25);
  assert.equal(podman.memoryBytes, 32 * 1024 ** 2);
  assert.equal(podman.memoryLimitBytes, 1024 ** 3);
  assert.equal(podman.pids, 6);
  assert.equal(parseBytes("1.5GB"), 1.5e9);
  assert.equal(parseBytes("--"), undefined);
  const apple = parseAppleStats(JSON.stringify([{ id: "name", cpuUtilization: 1.5025, memoryUsageBytes: 123, memoryLimitBytes: 1024 ** 3, numProcesses: 5 }]), "name");
  assert.equal(apple.cpuPercent, 150.25);
  assert.equal(apple.memoryBytes, 123);
  const partial = parseAppleStats('[{"id":"name","memoryUsageBytes":0,"cpuUtilization":null}]', "name");
  assert.equal(partial.cpuPercent, undefined);
  assert.equal(partial.memoryBytes, 0);
  for (const text of ["[]", "{}", "bad", '[{"id":"name","cpuUtilization":-1}]']) assert.throws(() => parseAppleStats(text, "name"));
  assert.throws(() => parsePodmanStats("garbage"));
  assert.throws(() => parsePodmanStats("--|--|--"));
});

test("stats requests are bounded and don't target all containers", async () => {
  for (const id of ["podman", "apple"] as const) {
    const b = createBackend(id, async (args, options) => {
      assert.equal(args.at(-1), "chosen");
      assert.ok(args.includes("--no-stream"));
      assert.equal(options?.timeoutMs, 5_000);
      assert.equal(options?.maxBytes, 256 * 1024);
      return ok(id === "apple" ? '[{"id":"chosen","memoryUsageBytes":10}]' : "0%|10B / 1GiB|1");
    });
    assert.equal((await b.stats("chosen")).memoryBytes, 10);
  }
});

test("stale/in-flight metrics cannot revive a stopped or recreated sandbox", async () => {
  let resolve!: (result: RunResult) => void;
  const s = new Sandbox("/project", "image", "off", async (args) => args[0] === "stats" ? new Promise<RunResult>((r) => { resolve = r; }) : ok());
  await s.start();
  const pending = s.refreshMetrics();
  await s.stop(); await s.start();
  resolve(ok("90%|500MiB / 1GiB|100"));
  await pending;
  assert.equal(s.metrics, undefined);
  assert.equal(s.metricsState, "pending");
  await s.stop();
});

test("failed stats clear the previous sample instead of displaying it as current", async () => {
  let broken = false;
  const s = new Sandbox("/project", "image", "on", async (args) => args[0] === "stats" ? (broken ? fail("no stats") : ok("0%|2MiB / 1GiB|1")) : ok());
  await s.start(); await s.refreshMetrics();
  assert.equal(s.metricsState, "available");
  broken = true; await s.refreshMetrics();
  assert.equal(s.metrics, undefined);
  assert.equal(s.metricsState, "unavailable");
  assert.ok(s.name);
  await s.stop();
});
