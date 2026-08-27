/**
 * Tiny file-backed JSON store.
 *
 * Deliberately not a database: this app keeps a handful of local order records
 * and, in mock mode, the simulated deliveries. Writing to disk (rather than a
 * module-level Map) means state survives dev-server hot reloads and restarts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");

/** Serialises writes per file so two concurrent requests can't clobber each other. */
const writeQueues = new Map<string, Promise<unknown>>();

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath(name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(name: string, value: T): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const target = filePath(name);
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/** Read-modify-write under a per-file lock. */
export async function updateJson<T>(
  name: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(name) ?? Promise.resolve();

  const next = previous.then(async () => {
    const current = await readJson<T>(name, fallback);
    const updated = await mutate(current);
    await writeJson(name, updated);
    return updated;
  });

  // Keep the chain alive even if this link rejects.
  writeQueues.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}
