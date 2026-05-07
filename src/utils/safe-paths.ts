/**
 * Lightweight safe-path helper. Mirrors a subset of
 * `vibecontrols-agent`'s `core/safe-paths.ts` so this plugin doesn't depend
 * on the agent's source tree.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SafePathResult {
  path: string;
  realPath: string;
}

function configuredRoots(): string[] {
  const raw = process.env.VIBECONTROLS_ALLOWED_ROOTS;
  if (raw) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [process.cwd(), os.homedir(), os.tmpdir()].filter(Boolean);
}

async function realpathIfExists(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function allowedRootRealpaths(): Promise<string[]> {
  const roots: string[] = [];
  for (const root of configuredRoots()) {
    const resolved = path.resolve(root);
    const real = (await realpathIfExists(resolved)) ?? resolved;
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

function isWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function assertUnderAllowedRoot(realPath: string): Promise<void> {
  const roots = await allowedRootRealpaths();
  if (!roots.some((root) => isWithinRoot(realPath, root))) {
    throw new Error("Access denied: path is outside allowed directories");
  }
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const MAX_FILE_READ_BYTES = positiveIntFromEnv(
  "VIBECONTROLS_MAX_FILE_READ_BYTES",
  10 * 1024 * 1024,
);

export const MAX_DIRECTORY_ENTRIES = positiveIntFromEnv(
  "VIBECONTROLS_MAX_DIRECTORY_ENTRIES",
  2000,
);

const SENSITIVE_PATTERNS = [
  /(?:^|\/)\.env(?:\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /(?:^|\/)id_rsa(?:$|\.)/,
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.git\/config$/,
  /(?:^|\/)\.npmrc$/,
];

const PROTECTED_PATHS = ["/", "/etc", "/usr", "/bin", "/sbin", "/var", "/opt"];

export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATTERNS.some((rx) => rx.test(p));
}

export function isProtectedPath(p: string): boolean {
  const norm = path.resolve(p);
  return PROTECTED_PATHS.includes(norm);
}

export async function assertReadableFileSize(p: string): Promise<void> {
  const stats = await fs.stat(p);
  if (stats.size > MAX_FILE_READ_BYTES) {
    throw new Error(
      `File too large to read (${stats.size} bytes; cap is ${MAX_FILE_READ_BYTES})`,
    );
  }
}

export async function listDirectoryCapped(p: string): Promise<
  Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>
> {
  const entries = await fs.readdir(p, { withFileTypes: true });
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    return entries.slice(0, MAX_DIRECTORY_ENTRIES);
  }
  return entries;
}

export async function resolveSafePath(
  input: string,
  opts: { mustExist?: boolean; forWrite?: boolean } = {},
): Promise<SafePathResult> {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Path is required");
  }
  if (input.includes("\0")) {
    throw new Error("Path contains invalid null byte");
  }
  const expanded = input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : input;
  const resolved = path.resolve(expanded);
  let realPath = await realpathIfExists(resolved);
  if (!realPath) {
    if (opts.mustExist) {
      throw new Error("Path does not exist");
    }
    if (opts.forWrite) {
      const parent = path.dirname(resolved);
      const parentReal =
        (await realpathIfExists(parent)) ?? path.resolve(parent);
      await assertUnderAllowedRoot(parentReal);
      return { path: resolved, realPath: resolved };
    }
    realPath = resolved;
  }
  await assertUnderAllowedRoot(realPath);
  return { path: resolved, realPath };
}
