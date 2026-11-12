import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDefaultRuntime, saveDefaultRuntime } from "../src/settings.ts";

test("runtime defaults are optional, validated, persisted atomically and replaceable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-settings-"));
  const path = join(dir, "sandbox.json");
  try {
    assert.equal(await readDefaultRuntime(path), undefined);
    await saveDefaultRuntime("apple", path);
    assert.equal(await readDefaultRuntime(path), "apple");
    await saveDefaultRuntime("podman", path);
    assert.equal(await readDefaultRuntime(path), "podman");
    assert.deepEqual(await readdir(dir), ["sandbox.json"]);
    for (const invalid of ["{", "null", "[]", '{"runtime":"auto"}']) {
      await writeFile(path, invalid);
      await assert.rejects(readDefaultRuntime(path));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
