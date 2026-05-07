/**
 * REST API routes for the Ungit plugin.
 *
 * Prefix: /api/ungit
 *
 * Routes:
 *   GET  /status   - Current Ungit status (installed, running, port, pid)
 *   POST /install  - Install Ungit globally via npm
 *   POST /start    - Start Ungit with optional working directory and port
 *   POST /stop     - Stop the Ungit process
 *   POST /restart  - Restart Ungit with optional new working directory
 */

import { Elysia } from "elysia";
import type { HostServices, StartBody } from "./types.js";
import {
  checkInstallation,
  installUngit,
} from "./lib/process.js";
import {
  startUngit,
  stopUngit,
  getStatus as getProcessStatus,
} from "./lib/process.js";

// Module-level install state
let isInstalling = false;
let installError: string | null = null;

export function createUngitRoutes(_hostServices: HostServices) {
  return new Elysia({ prefix: "/api/ungit" })

    // GET /api/ungit/status
    .get("/status", async () => {
      const installInfo = await checkInstallation();
      const processStatus = getProcessStatus();

      return {
        installed: installInfo.installed,
        installing: isInstalling,
        running: processStatus.running,
        pid: processStatus.pid,
        port: processStatus.port,
        workingDir: processStatus.workingDir,
        error: installError || processStatus.error || undefined,
      };
    })

    // POST /api/ungit/install
    .post("/install", async ({ set }) => {
      if (isInstalling) {
        set.status = 409;
        return { error: "Installation already in progress" };
      }

      const check = await checkInstallation();
      if (check.installed) {
        return {
          message: "Ungit is already installed",
          binaryPath: check.binaryPath,
        };
      }

      // Start async installation
      isInstalling = true;
      installError = null;

      // Fire and forget -- caller polls /status
      (async () => {
        try {
          const result = await installUngit();
          if (!result.success) {
            installError = result.error || "Installation failed";
          }
        } catch (err) {
          installError =
            err instanceof Error ? err.message : "Installation failed";
        } finally {
          isInstalling = false;
        }
      })();

      return {
        message: "Installation started -- poll GET /api/ungit/status",
      };
    })

    // POST /api/ungit/start
    .post("/start", async ({ body, set }) => {
      const { workingDir, port } = (body as StartBody) || {};

      const check = await checkInstallation();
      if (!check.installed) {
        set.status = 400;
        return {
          error: "Ungit is not installed. POST /api/ungit/install first",
        };
      }

      try {
        const result = await startUngit({
          workingDir,
          port,
        });
        return {
          message: "Ungit started",
          pid: result.pid,
          port: result.port,
          workingDir: workingDir || process.env.HOME || "/",
        };
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : "Failed to start",
        };
      }
    })

    // POST /api/ungit/stop
    .post("/stop", async () => {
      await stopUngit();
      return { message: "Ungit stopped" };
    })

    // POST /api/ungit/restart
    .post("/restart", async ({ body, set }) => {
      const { workingDir } = (body as Partial<StartBody>) || {};

      const check = await checkInstallation();
      if (!check.installed) {
        set.status = 400;
        return { error: "Ungit is not installed" };
      }

      await stopUngit();

      try {
        const result = await startUngit({ workingDir });
        return {
          message: "Ungit restarted",
          pid: result.pid,
          port: result.port,
          workingDir: workingDir || process.env.HOME || "/",
        };
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : "Failed to restart",
        };
      }
    });
}
