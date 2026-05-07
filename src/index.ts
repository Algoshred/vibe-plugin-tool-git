/**
 * @burdenoff/vibe-plugin-git v1.0.0
 *
 * Visual Git Client via Ungit — reverse-proxied through the VibeControls
 * agent. Manages the Ungit child process lifecycle (install, start, stop)
 * and proxies all traffic at /ungit/* with session cookie auth.
 *
 * Registers:
 *   - Elysia routes: /api/ungit/*  (REST API)
 *   - Proxy routes:  /ungit/*      (reverse proxy to ungit)
 *   - CLI command:   vibe ungit {status,install,start,stop}
 *
 * Install: vibe plugin install @burdenoff/vibe-plugin-git
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";
import type { HostServices, VibePlugin } from "./types.js";
import type { GitPluginRouteDeps } from "./git-types.js";
import { getRunningPort, stopUngit } from "./lib/process.js";
import { createRoutes as createGitTrackerRoutes } from "./git-routes.js";
import { registerGitCommands } from "./git-commands.js";
import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
  type OutputFlags,
} from "./utils/multimode.js";
import { interactiveDetail } from "./utils/interactive.js";

// ---------------------------------------------------------------------------
// JSON shaping helpers
// ---------------------------------------------------------------------------

const SECRET_RX = /(token|secret|password|apikey|api_key)/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_RX.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

// Re-export types for external consumers
export type {
  VibePlugin,
  HostServices,
  StorageProvider,
  EventBus,
  ServiceRegistry,
  UngitStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(
  urlPath: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": API_KEY,
      ...options?.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Captured API key (set during onServerStart for proxy auth validation)
// ---------------------------------------------------------------------------

let agentApiKey: string | null = null;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const vibePlugin: VibePlugin = {
  name: "ungit",
  version: "1.0.0",
  description: "Visual Git Client (Ungit)",
  tags: ["frontend", "integration"],
  hasUI: true,
  cliCommand: "ungit",
  apiPrefix: "/api/ungit",
  publicPaths: ["/ungit/"],

  async onServerStart(app: Elysia, hostServices: HostServices) {
    // Register REST API routes
    const { createUngitRoutes } = await import("./routes.js");
    app.use(createUngitRoutes(hostServices));

    // Capture the API key from the app's decorator for proxy auth
    try {
      const decorated = app as unknown as { decorator: { apiKey?: string } };
      agentApiKey = decorated.decorator?.apiKey ?? null;
    } catch {
      agentApiKey = process.env.AGENT_API_KEY ?? null;
    }

    // Mount reverse proxy at /ungit/*
    const { createUngitProxy } = await import("./lib/proxy.js");
    app.use(
      createUngitProxy(
        () => getRunningPort(),
        (key: string) => {
          if (!agentApiKey) return false;
          return key === agentApiKey;
        },
      ),
    );

    // Mount the merged git-repository tracker routes at /api/git when the
    // agent has injected the storage surface. The host's PluginRouteDeps
    // contract exposes db + serviceRegistry, so we look them up off the
    // app decorator to keep this back-compatible.
    try {
      const decorated = app as unknown as {
        decorator: { db?: unknown; serviceRegistry?: unknown };
      };
      const db = decorated.decorator?.db;
      const serviceRegistry = decorated.decorator?.serviceRegistry;
      if (db && serviceRegistry) {
        const gitDeps: GitPluginRouteDeps = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          db: db as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          serviceRegistry: serviceRegistry as any,
        };
        app.group("/api/git", (group) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          group.use(createGitTrackerRoutes(gitDeps) as any),
        );
        console.log(
          "  Plugin 'ungit' also registered: /api/git (repo tracker)",
        );
      }
    } catch (err) {
      console.warn("  Plugin 'ungit' git tracker mount skipped:", err);
    }

    console.log("  Plugin 'ungit' registered routes: /api/ungit, /ungit");
  },

  async onServerStop() {
    await stopUngit();
    console.log("  Plugin 'ungit' stopped");
  },

  onCliSetup(program: Command) {
    const cmd = program
      .command("ungit")
      .description("Visual Git Client (Ungit)");

    // vibe ungit status
    cmd
      .command("status")
      .description("Show Ungit status")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (opts: OutputFlags) => {
        await runMultimode<unknown>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch("/api/ungit/status");
            return await res.json();
          },
          plain: (data) => {
            console.log(JSON.stringify(data, null, 2));
          },
          interactive: async (data) => {
            await interactiveDetail({
              title: "ungit — status",
              body: JSON.stringify(data, null, 2),
            });
          },
          json: (data) => redact(data),
        });
      });

    // vibe ungit install
    cmd
      .command("install")
      .description("Install Ungit globally via npm")
      .option("--json", "Emit JSON")
      .action(async (opts: OutputFlags) => {
        if (!opts.json) console.log("Installing Ungit...");
        const res = await apiFetch("/api/ungit/install", { method: "POST" });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "install", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe ungit start [--dir <dir>] [--port <port>]
    cmd
      .command("start")
      .description("Start Ungit")
      .option("--dir <dir>", "Working directory for git operations")
      .option("--port <port>", "Port to bind to")
      .option("--json", "Emit JSON")
      .action(async (opts: { dir?: string; port?: string } & OutputFlags) => {
        const body: Record<string, unknown> = {};
        if (opts.dir) body.workingDir = opts.dir;
        if (opts.port) body.port = parseInt(opts.port, 10);

        const res = await apiFetch("/api/ungit/start", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "start", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe ungit stop
    cmd
      .command("stop")
      .description("Stop Ungit")
      .option("--json", "Emit JSON")
      .action(async (opts: OutputFlags) => {
        const res = await apiFetch("/api/ungit/stop", { method: "POST" });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "stop", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe ungit restart [--dir <dir>]
    cmd
      .command("restart")
      .description("Restart Ungit with optional new working directory")
      .option("--dir <dir>", "New working directory")
      .option("--json", "Emit JSON")
      .action(async (opts: { dir?: string } & OutputFlags) => {
        const body: Record<string, unknown> = {};
        if (opts.dir) body.workingDir = opts.dir;

        const res = await apiFetch("/api/ungit/restart", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "restart", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // Also register the merged `vibe git ...` repo-tracker subcommands.
    registerGitCommands(program);
  },
};

export default vibePlugin;
