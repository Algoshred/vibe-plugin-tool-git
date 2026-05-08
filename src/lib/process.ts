/**
 * Ungit Process Lifecycle Manager
 *
 * Manages starting, stopping, and monitoring the Ungit child process.
 * Ungit binds to 127.0.0.1 only -- access is via the agent reverse proxy.
 */

import type { Subprocess } from "bun";
import type { UngitStatus } from "../types.js";

// -- Module-level state (not persisted -- on-demand only) -------------------

let childProcess: Subprocess | null = null;
let currentPort: number | null = null;
let currentWorkingDir: string | null = null;
let currentPid: number | null = null;
let lastError: string | null = null;
let isStarting = false;

const DEFAULT_PORT = 8448;
const PORT_RANGE_END = 8458;

// -- Port availability check ------------------------------------------------

async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch() {
        return new Response();
      },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port in the range [DEFAULT_PORT, PORT_RANGE_END].
 */
export async function findAvailablePort(preferred?: number): Promise<number> {
  const start = preferred ?? DEFAULT_PORT;

  if (await isPortAvailable(start)) return start;

  for (let port = DEFAULT_PORT; port <= PORT_RANGE_END; port++) {
    if (port === start) continue;
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(
    `No available port in range ${DEFAULT_PORT}-${PORT_RANGE_END}`,
  );
}

// -- Installation checks ----------------------------------------------------

/**
 * Check whether Ungit is installed (globally or locally).
 */
export async function checkInstallation(): Promise<{
  installed: boolean;
  binaryPath?: string;
}> {
  // Check local node_modules first (plugin dependency)
  try {
    const localPath = new URL(
      "../../node_modules/.bin/ungit",
      import.meta.url,
    ).pathname;
    const file = Bun.file(localPath);
    if (await file.exists()) {
      return { installed: true, binaryPath: localPath };
    }
  } catch {
    // Not found locally
  }

  // Check global via Bun.which (cross-platform; handles PATHEXT on Windows).
  try {
    const path = Bun.which("ungit");
    if (path) {
      return { installed: true, binaryPath: path };
    }
  } catch {
    // not found
  }

  return { installed: false };
}

/**
 * Install Ungit globally via npm.
 */
export async function installUngit(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const proc = Bun.spawn(["npm", "install", "-g", "ungit"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        success: false,
        error: `npm install -g ungit failed (exit ${exitCode}): ${stderr}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Installation failed",
    };
  }
}

// -- Process management -----------------------------------------------------

/**
 * Start Ungit as a child process.
 */
export async function startUngit(options?: {
  workingDir?: string;
  port?: number;
}): Promise<{ pid: number; port: number }> {
  if (childProcess && currentPid) {
    // Already running -- check if still alive
    if (isProcessAlive(currentPid)) {
      return { pid: currentPid, port: currentPort! };
    }
    // Process died, clean up
    childProcess = null;
    currentPid = null;
  }

  if (isStarting) {
    throw new Error("Ungit is already starting");
  }

  isStarting = true;
  lastError = null;

  try {
    const port = await findAvailablePort(options?.port);
    const workingDir = options?.workingDir || process.env.HOME || "/";

    // Resolve ungit binary
    const install = await checkInstallation();
    if (!install.installed || !install.binaryPath) {
      throw new Error("Ungit is not installed");
    }

    const args = [
      install.binaryPath,
      "--port",
      String(port),
      "--no-b",
      "--ungitBindIp",
      "127.0.0.1",
      "--rootPath",
      "/ungit",
    ];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: workingDir,
      env: {
        ...process.env,
        PORT: undefined,
      },
    });

    childProcess = proc;
    currentPort = port;
    currentWorkingDir = workingDir;
    currentPid = proc.pid;

    // Monitor for unexpected exit
    proc.exited.then((code) => {
      if (childProcess === proc) {
        childProcess = null;
        currentPid = null;
        if (code !== 0 && code !== null) {
          lastError = `Ungit exited with code ${code}`;
        }
      }
    });

    // Wait briefly for startup
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify it started
    if (!isProcessAlive(proc.pid)) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Ungit failed to start: ${stderr}`);
    }

    return { pid: proc.pid, port };
  } catch (err) {
    lastError = err instanceof Error ? err.message : "Failed to start";
    throw err;
  } finally {
    isStarting = false;
  }
}

/**
 * Stop the Ungit process.
 */
export async function stopUngit(): Promise<void> {
  if (!childProcess || !currentPid) {
    childProcess = null;
    currentPid = null;
    return;
  }

  const proc = childProcess;
  const pid = currentPid;

  // Clear references immediately
  childProcess = null;
  currentPid = null;
  currentPort = null;
  currentWorkingDir = null;
  lastError = null;

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be dead
    return;
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }

  // Wait for the process handle
  try {
    await proc.exited;
  } catch {
    // Ignore
  }
}

/**
 * Get the current status of Ungit.
 */
export function getStatus(): UngitStatus {
  const running = Boolean(currentPid && isProcessAlive(currentPid));

  // Clean up stale state
  if (!running && childProcess) {
    childProcess = null;
    currentPid = null;
  }

  return {
    installed: true, // Caller checks installation separately
    running,
    pid: running ? (currentPid ?? undefined) : undefined,
    port: running ? (currentPort ?? undefined) : undefined,
    workingDir: running ? (currentWorkingDir ?? undefined) : undefined,
    error: lastError ?? undefined,
  };
}

/**
 * Get the port Ungit is currently running on.
 */
export function getRunningPort(): number | null {
  if (!currentPid || !isProcessAlive(currentPid)) return null;
  return currentPort;
}

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
