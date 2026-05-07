import type { Command } from "commander";
import {
  type JsonRow,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  errMsg,
  fail,
  formatTable,
  getAgentUrl,
  header,
  info,
  kv,
  shortId,
  success,
  timeAgo,
} from "./utils/cli-helpers.js";
import {
  maybePrintJson,
  pickOutputMode,
  runMultimode,
} from "./utils/multimode.js";
import { interactiveTable, type TableRow } from "./utils/interactive.js";

const DEFAULT_AGENT_URL = "http://localhost:3005";

export function registerGitCommands(
  programArg: unknown,
  _hostServices?: unknown,
): void {
  const program = programArg as Command;
  const cmd = program.command("git").description("Manage git repositories");

  // git list
  cmd
    .command("list")
    .description("List discovered git repositories")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .option("--plain", "Force plain text output")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await runMultimode({
          mode: pickOutputMode(merged),
          fetchData: async () => {
            const data = await apiGet<{ repositories: JsonRow[] }>(
              url,
              "/api/git",
            );
            return data.repositories || [];
          },
          plain: (repos) => {
            if (!repos || repos.length === 0) {
              info("No git repositories found.");
              return;
            }
            header("Git Repositories");
            formatTable(
              repos.map((r: JsonRow) => ({
                ID: shortId(r.id),
                Name: r.name || "-",
                Path: r.path || "-",
                Type: r.type || r.projectType || "-",
                Submodule: r.isSubmodule ? "Yes" : "No",
                Scanned: r.scannedAt ? timeAgo(r.scannedAt) : "-",
              })),
            );
          },
          interactive: async (repos) => {
            if (!repos || repos.length === 0) {
              header("Git Repositories");
              info("No git repositories found.");
              return;
            }
            const rows: TableRow[] = repos.map((r: JsonRow) => ({
              id: String(r.id),
              label: r.name || shortId(r.id),
              hint: r.type || r.projectType || "",
              detail: [
                `ID:        ${r.id}`,
                `Name:      ${r.name ?? "-"}`,
                `Path:      ${r.path ?? "-"}`,
                `Type:      ${r.type ?? r.projectType ?? "-"}`,
                `Submodule: ${r.isSubmodule ? "Yes" : "No"}`,
                `Scanned:   ${r.scannedAt ? timeAgo(r.scannedAt) : "-"}`,
              ].join("\n"),
            }));
            await interactiveTable({
              title: `vibe git list — ${repos.length} repo(s)`,
              rows,
            });
          },
          json: (repos) =>
            repos.map((r: JsonRow) => ({
              id: r.id,
              name: r.name ?? null,
              path: r.path ?? null,
              type: r.type ?? r.projectType ?? null,
              isSubmodule: !!r.isSubmodule,
              scannedAt: r.scannedAt ?? null,
            })),
        });
      } catch (err) {
        fail(errMsg(err));
      }
    });

  // git scan
  cmd
    .command("scan")
    .description("Scan a directory for git repositories")
    .requiredOption("--dir <directory>", "Directory to scan")
    .option("--depth <depth>", "Scan depth", "3")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const result = await apiPost<JsonRow>(url, "/api/git/scan", {
          directory: options.dir,
          depth: parseInt(options.depth, 10),
        });
        if (
          maybePrintJson(merged, {
            ok: true,
            found: result?.found ?? result?.repositories?.length ?? 0,
          })
        )
          return;
        success("Git scan completed.");
        if (result?.found !== undefined) kv("Repositories found", result.found);
        if (result?.repositories)
          kv("Repositories found", result.repositories.length);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // git update
  cmd
    .command("update")
    .description("Update a git repository entry")
    .requiredOption("-i, --id <id>", "Repository ID")
    .option("--vite-port <port>", "Vite dev server port")
    .option("--project-type <type>", "Project type")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const body: JsonRow = {};
        if (options.vitePort) body.vitePort = parseInt(options.vitePort, 10);
        if (options.projectType) body.projectType = options.projectType;
        await apiPut<JsonRow>(url, `/api/git/${options.id}`, body);
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success(`Repository ${shortId(options.id)} updated.`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // git delete
  cmd
    .command("delete")
    .description("Delete a git repository entry")
    .requiredOption("-i, --id <id>", "Repository ID")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        await apiDelete<JsonRow>(url, `/api/git/${options.id}`);
        if (maybePrintJson(merged, { ok: true, id: options.id })) return;
        success(`Repository ${shortId(options.id)} deleted.`);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });

  // git fix-hierarchy
  cmd
    .command("fix-hierarchy")
    .description("Fix repository parent-child hierarchy")
    .option("--agent-url <url>", "Agent URL", DEFAULT_AGENT_URL)
    .option("--json", "Emit JSON")
    .action(async function (this: Command, options) {
      const merged = { ...program.opts(), ...options };
      try {
        const url = getAgentUrl(options);
        const result = await apiPost<JsonRow>(
          url,
          "/api/git/fix-hierarchy",
          {},
        );
        if (
          maybePrintJson(merged, {
            ok: true,
            fixed: result?.fixed ?? null,
          })
        )
          return;
        success("Hierarchy fix completed.");
        if (result?.fixed !== undefined) kv("Fixed", result.fixed);
      } catch (err) {
        if (merged.json) {
          maybePrintJson(merged, { ok: false, error: errMsg(err) });
          return;
        }
        fail(errMsg(err));
      }
    });
}
