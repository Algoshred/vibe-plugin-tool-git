/**
 * Git Plugin — Routes
 *
 * Git repository scanning, tracking, and hierarchy management.
 *
 * Endpoints:
 *   GET    /           — List all tracked git repositories
 *   GET    /:id        — Get repository by ID
 *   POST   /scan       — Scan directory for git repositories
 *   PUT    /:id        — Update repository metadata
 *   DELETE /:id        — Delete repository from tracking
 *   POST   /fix-hierarchy — Fix parent/child relationships
 */

import { Elysia, t } from "elysia";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { GitPluginRouteDeps as PluginRouteDeps } from "./git-types.js";
import { listDirectoryCapped, resolveSafePath } from "./utils/safe-paths.js";

// ── Project Type Detection ──────────────────────────────────────────────

async function detectProjectType(
  directory: string,
): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(directory);

    if (entries.includes("package.json")) {
      try {
        const packageJson = JSON.parse(
          await fs.readFile(path.join(directory, "package.json"), "utf8"),
        );
        const deps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        if (deps.react || deps["@types/react"]) return "react";
        if (deps.vue || deps["@vue/cli"]) return "vue";
        if (deps.angular || deps["@angular/core"]) return "angular";
        if (deps.next || deps["@types/next"]) return "nextjs";
        if (deps.nuxt || deps["@nuxt/core"]) return "nuxtjs";
        if (deps.svelte || deps["@sveltejs/kit"]) return "svelte";
        if (deps.express || deps.fastify || deps.koa) return "nodejs-backend";
        if (deps.electron) return "electron";
        if (deps.vite) return "vite";
      } catch {
        /* fallback */
      }
      return "nodejs";
    }

    if (
      entries.includes("setup.py") ||
      entries.includes("requirements.txt") ||
      entries.includes("pyproject.toml") ||
      entries.includes("Pipfile")
    ) {
      if (entries.includes("manage.py")) return "django";
      if (entries.includes("app.py")) return "flask";
      return "python";
    }

    if (entries.includes("go.mod")) return "go";
    if (entries.includes("Cargo.toml")) return "rust";
    if (entries.includes("pom.xml")) return "maven";
    if (
      entries.includes("build.gradle") ||
      entries.includes("build.gradle.kts")
    )
      return "gradle";
    if (entries.includes("Gemfile")) return "ruby";
    if (entries.includes("composer.json")) return "php";
    if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln")))
      return "dotnet";
    if (entries.includes("CMakeLists.txt") || entries.includes("Makefile"))
      return "cpp";
    if (entries.includes("Package.swift")) return "swift";
    if (entries.includes("pubspec.yaml")) return "flutter";
    if (entries.some((e) => e.endsWith(".tf"))) return "terraform";
    if (entries.includes("Dockerfile")) return "docker";
  } catch {
    /* ignore */
  }

  return undefined;
}

async function detectVitePort(directory: string): Promise<number | undefined> {
  try {
    const variants = ["vite.config.ts", "vite.config.js"];
    for (const name of variants) {
      try {
        const content = await fs.readFile(path.join(directory, name), "utf-8");
        const match = content.match(/port:\s*(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch {
        /* next */
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// ── Git Repo Scanner ────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
]);

const MAX_SCAN_DEPTH = parseInt(
  process.env.VIBECONTROLS_GIT_SCAN_MAX_DEPTH ?? "8",
  10,
);
const MAX_SCAN_DIRECTORIES = parseInt(
  process.env.VIBECONTROLS_GIT_SCAN_MAX_DIRECTORIES ?? "5000",
  10,
);

async function scanForGitRepositories(
  directory: string,
  includeSubmodules: boolean,
  parentPath?: string,
  state: { visited: number } = { visited: 0 },
  depth = 0,
): Promise<
  Array<{
    path: string;
    name: string;
    parentPath?: string;
    isSubmodule: boolean;
    projectType?: string;
    vitePort?: number;
  }>
> {
  const repositories: Array<{
    path: string;
    name: string;
    parentPath?: string;
    isSubmodule: boolean;
    projectType?: string;
    vitePort?: number;
  }> = [];

  if (depth > MAX_SCAN_DEPTH || state.visited >= MAX_SCAN_DIRECTORIES) {
    return repositories;
  }
  state.visited += 1;

  try {
    const entries = await listDirectoryCapped(directory);
    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());

    if (hasGit) {
      repositories.push({
        path: directory,
        name: path.basename(directory),
        parentPath,
        isSubmodule: !!parentPath,
        projectType: await detectProjectType(directory),
        vitePort: await detectVitePort(directory),
      });

      if (!includeSubmodules) return repositories;
      parentPath = directory;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !SKIP_DIRS.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        const subPath = path.join(directory, entry.name);
        const subRepos = await scanForGitRepositories(
          subPath,
          includeSubmodules,
          parentPath,
          state,
          depth + 1,
        );
        repositories.push(...subRepos);
      }
    }
  } catch {
    /* permission errors */
  }

  return repositories;
}

// ── Routes ──────────────────────────────────────────────────────────────

export function createRoutes(deps: PluginRouteDeps) {
  const { db } = deps;

  return (
    new Elysia()
      // List all tracked git repositories
      .get("/", async () => {
        const repositories = await db.getAllGitRepositories();
        return { repositories };
      })

      // Get repository by ID
      .get("/:id", async ({ params, set }) => {
        const repository = await db.getGitRepository(params.id);
        if (!repository) {
          set.status = 404;
          return { error: "Repository not found" };
        }
        return { repository };
      })

      // Scan directory for git repositories
      .post(
        "/scan",
        async ({ body, set }) => {
          try {
            const safeDirectory = (
              await resolveSafePath(body.directory, { mustExist: true })
            ).path;
            const stats = await fs.stat(safeDirectory);
            if (!stats.isDirectory()) {
              set.status = 400;
              return { error: "Path is not a directory" };
            }

            const repositories = await scanForGitRepositories(
              safeDirectory,
              body.includeSubmodules ?? true,
            );

            const savedRepos = [];
            for (const repo of repositories) {
              const existing = await db.getGitRepositoryByPath(repo.path);
              if (existing) {
                await db.updateGitRepository(existing.id, repo);
                savedRepos.push({ ...existing, ...repo });
              } else {
                const newRepo = await db.createGitRepository({
                  id: globalThis.crypto.randomUUID(),
                  ...repo,
                });
                savedRepos.push(newRepo);
              }
            }

            return {
              repositories: savedRepos,
              scannedPath: safeDirectory,
              totalFound: savedRepos.length,
            };
          } catch (err) {
            set.status = 500;
            return { error: "Failed to scan directory", details: String(err) };
          }
        },
        {
          body: t.Object({
            directory: t.String(),
            includeSubmodules: t.Optional(t.Boolean()),
          }),
        },
      )

      // Update repository metadata
      .put(
        "/:id",
        async ({ params, body, set }) => {
          const repository = await db.getGitRepository(params.id);
          if (!repository) {
            set.status = 404;
            return { error: "Repository not found" };
          }

          try {
            await db.updateGitRepository(params.id, body);
            return { success: true };
          } catch (err) {
            set.status = 500;
            return {
              error: "Failed to update repository",
              details: String(err),
            };
          }
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            projectType: t.Optional(t.String()),
            vitePort: t.Optional(t.Number()),
          }),
        },
      )

      // Delete repository from tracking
      .delete("/:id", async ({ params, set }) => {
        const repository = await db.getGitRepository(params.id);
        if (!repository) {
          set.status = 404;
          return { error: "Repository not found" };
        }

        try {
          await db.deleteGitRepository(params.id);
          return { success: true };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to delete repository", details: String(err) };
        }
      })

      // Fix repository hierarchy
      .post("/fix-hierarchy", async ({ set }) => {
        try {
          const result = await db.fixGitHierarchy();
          const repos = await db.getAllGitRepositories();
          return { success: true, fixed: result.fixed, total: repos.length };
        } catch (err) {
          set.status = 500;
          return { error: "Failed to fix hierarchy", details: String(err) };
        }
      })
  );
}
