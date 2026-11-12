import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseRuntime, type RuntimeName } from "./backends.ts";

/** User-global only: never consult configuration in the mounted project. */
export const settingsPath = () => join(getAgentDir(), "sandbox.json");

export async function readDefaultRuntime(path = settingsPath()): Promise<RuntimeName | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid sandbox settings: ${path}`);
  return value.runtime === undefined ? undefined : parseRuntime(value.runtime);
}

export async function saveDefaultRuntime(runtime: RuntimeName, path = settingsPath()): Promise<void> {
  parseRuntime(runtime);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ runtime }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
