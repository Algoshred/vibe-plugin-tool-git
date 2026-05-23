/**
 * @vibecontrols/vibe-plugin-tool-git
 *
 * Visual Git Client via Ungit — reverse-proxied through the VibeControls
 * agent. Manages the Ungit child process lifecycle (install, start, stop)
 * and proxies all traffic at /ungit/* with session cookie auth.
 *
 * Registers:
 *   - Elysia routes: /api/ungit/*  (REST API)
 *   - Proxy routes:  /ungit/*      (reverse proxy to ungit)
 *   - CLI command:   vibe ungit {status,install,start,stop,restart}
 *
 * Migrated to consume `@vibecontrols/plugin-sdk` for the contract,
 * lifecycle, telemetry, CLI multimode, and redaction helpers.
 */

import type { Command } from "commander";

import {
  createLifecycleHooks,
  pickOutputMode,
  redact,
  runMultimode,
  maybePrintJson,
  TelemetryEmitter,
  type HostServices,
  type OutputFlags,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk";

import type { UngitStatus } from "./types.js";
import { getRunningPort, stopUngit } from "./lib/process.js";
import { interactiveDetail } from "./utils/interactive.js";

export type { UngitStatus, StartBody } from "./types.js";

/**
 * Local extension of the SDK contract — agrees additive fields the host
 * agent reads from the registry (UI flag + public path allowlist) that
 * the SDK contract leaves to the host implementation.
 */
interface PluginCapabilitiesV1 {
  restPaths: string[];
  wsTopics: string[];
  rpcMethods: string[];
}

interface PluginContributionV1 {
  mountPoint: string;
  id: string;
  title: string;
  icon?: string;
  order?: number;
  runtimes: Array<"iframe" | "in-process">;
  capabilities: PluginCapabilitiesV1;
  /**
   * Free-form mount-point metadata. The agent's contributions endpoint
   * reads `meta.url` to override the default `/ui/<pluginKey>` iframe
   * src — needed here because Ungit lives at `/ungit/`, not under
   * `/ui/...`.
   */
  meta?: { url?: string };
}

type UngitVibePlugin = VibePlugin & {
  hasUI?: boolean;
  publicPaths?: string[];
  /**
   * PR-12c — declare the Ungit UI as a `vibe.detailTab` contribution
   * so the Vibe detail page renders it in the strip when the host's
   * `vibes.tabs.gitops-iframe` flag is on. `meta.url` points at
   * `/ungit/` (the existing reverse-proxied Ungit instance) rather
   * than the default `/ui/<pluginKey>`.
   */
  ui?: {
    title: string;
    icon?: string;
    staticDir?: string;
    capabilities?: PluginCapabilitiesV1;
    contributions?: PluginContributionV1[];
  };
};

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

const PLUGIN_NAME = "ungit";
const PLUGIN_VERSION = "2026.509.2";

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "tool.ready",
    onInit: async (hostServices: HostServices) => {
      const telemetry = new TelemetryEmitter(
        PLUGIN_NAME,
        PLUGIN_VERSION,
        hostServices,
      );
      telemetry.emitEvent("tool.ready", { provider: "git" });
    },
  });

  const plugin: UngitVibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      audit: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: "Visual Git Client (Ungit)",
    tags: ["frontend", "integration"],
    hasUI: true,
    cliCommand: "ungit",
    apiPrefix: "/api/ungit",
    publicPaths: ["/ungit/"],
    ui: {
      title: "GitOps",
      icon: "GitMerge",
      // Static dir holds the simple per-Vibe Git metadata iframe
      // (`ui-git/index.html`). Ungit lives at `/ungit/` and is served
      // by the reverse-proxy below — not via this staticDir.
      staticDir: `${import.meta.dir}/ui-git`,
      capabilities: {
        restPaths: ["/ungit", "/api/ungit", "/ui/ungit"],
        wsTopics: [],
        rpcMethods: ["getContext"],
      },
      contributions: [
        // PR-12a — inline Git tab migration. Reads gitBranch/gitStatus/
        // gitRemote via the host's `getContext` RPC. Tab takes the same
        // ordering slot as the inline `git` tab (~30) so the user sees
        // no UX shift when the flag flips.
        {
          mountPoint: "vibe.detailTab",
          id: "plugin:git",
          title: "Git",
          icon: "GitBranch",
          order: 30,
          runtimes: ["iframe"],
          capabilities: {
            restPaths: ["/ui/ungit"],
            wsTopics: [],
            rpcMethods: ["getContext"],
          },
        },
        // PR-12c — GitOps (Ungit) tab migration. The iframe loads the
        // existing `/ungit/` reverse-proxied UI directly; `meta.url`
        // overrides the default `/ui/<pluginKey>` so the iframe src
        // points at the Ungit subprocess. Same ordering slot as the
        // inline `gitops` tab.
        {
          mountPoint: "vibe.detailTab",
          id: "plugin:gitops",
          title: "GitOps",
          icon: "GitMerge",
          order: 95,
          runtimes: ["iframe"],
          capabilities: {
            restPaths: ["/ungit", "/api/ungit"],
            wsTopics: [],
            rpcMethods: [],
          },
          meta: { url: "/ungit/" },
        },
      ],
    },

    async onServerStart(app: unknown, hostServices: HostServices) {
      await lifecycle.onServerStart(app, hostServices);

      // The host agent passes a real Elysia instance; cast to use it.
      const elysiaApp = app as {
        use: (plugin: unknown) => unknown;
        decorator?: { apiKey?: string };
      };

      // Register REST API routes
      const { createUngitRoutes } = await import("./routes.js");
      elysiaApp.use(createUngitRoutes(hostServices));

      // Capture the API key from the app's decorator for proxy auth
      try {
        agentApiKey = elysiaApp.decorator?.apiKey ?? null;
      } catch {
        agentApiKey = process.env.AGENT_API_KEY ?? null;
      }

      // Mount reverse proxy at /ungit/*
      const { createUngitProxy } = await import("./lib/proxy.js");
      elysiaApp.use(
        createUngitProxy(
          () => getRunningPort(),
          (key: string) => {
            if (!agentApiKey) return false;
            return key === agentApiKey;
          },
        ),
      );

      process.stdout.write(
        "  Plugin 'ungit' registered routes: /api/ungit, /ungit\n",
      );
    },

    async onServerStop() {
      await stopUngit();
      process.stdout.write("  Plugin 'ungit' stopped\n");
    },

    async onServerReady() {
      // Contribute capability metadata to the LLM Context feature.
      try {
        const sdkContext = (await import("@vibecontrols/plugin-sdk/context")) as {
          registerContextProvider?: (provider: {
            name: string;
            timeoutMs?: number;
            getContext: () => Promise<{
              pluginName: string;
              description?: string;
              data: Record<string, unknown>;
            }>;
          }) => void;
        };
        sdkContext.registerContextProvider?.({
          name: "tool-git",
          timeoutMs: 500,
          async getContext() {
            return {
              pluginName: "tool-git",
              description:
                "Visual Git client (Ungit) capability metadata exposed via UI iframe contributions.",
              data: {
                pluginVersion: PLUGIN_VERSION,
                cliCommand: "ungit",
                apiPrefix: "/api/ungit",
                tabs: ["plugin:git", "plugin:gitops"],
              },
            };
          },
        });
      } catch {
        // SDK doesn't support context — skip silently
      }
    },

    onCliSetup(programArg: unknown) {
      const program = programArg as Command;
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
          await runMultimode<UngitStatus>({
            mode: pickOutputMode(opts),
            fetchData: async () => {
              const res = await apiFetch("/api/ungit/status");
              return (await res.json()) as UngitStatus;
            },
            plain: (data) => {
              process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          if (!opts.json) process.stdout.write("Installing Ungit...\n");
          const res = await apiFetch("/api/ungit/install", { method: "POST" });
          const data = await res.json();
          if (
            maybePrintJson(opts, { ok: true, action: "install", result: data })
          )
            return;
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          if (
            maybePrintJson(opts, { ok: true, action: "restart", result: data })
          )
            return;
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        });
    },
  };

  return plugin;
};

export default createPlugin;
