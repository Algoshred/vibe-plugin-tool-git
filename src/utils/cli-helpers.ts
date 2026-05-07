/**
 * Compact CLI helpers — locally redeclared so the plugin doesn't depend on
 * `vibecontrols-agent`'s `src/cli/utils/*`.
 *
 * Covers: ANSI color/formatting, table rendering, error formatting, agent
 * URL/API key resolution, and a thin fetch wrapper.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const DEFAULT_AGENT_URL = "http://localhost:3005";

const LOCAL_AGENT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export type JsonRow = Record<string, any>;

// ── ANSI helpers ────────────────────────────────────────────────────────

export const colors = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[39m`,
};

export function header(text: string): void {
  console.log("");
  console.log(colors.bold(colors.cyan(text)));
  console.log(colors.gray("─".repeat(Math.min(text.length, 80))));
}

export function info(text: string): void {
  console.log(colors.blue("●") + " " + text);
}

export function success(text: string): void {
  console.log(colors.green("✓") + " " + text);
}

export function warn(text: string): void {
  console.log(colors.yellow("⚠") + " " + text);
}

export function fail(text: string): void {
  console.error(colors.red("✗") + " " + text);
  process.exitCode = 1;
}

export function kv(label: string, value: unknown): void {
  console.log(`  ${colors.gray(label + ":")} ${value}`);
}

export function shortId(id: string | undefined | null): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timeAgo(iso: string | Date | undefined | null): string {
  if (!iso) return "-";
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  if (!Number.isFinite(t)) return "-";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0] ?? {});
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - s.length));
  console.log(cols.map((c, i) => colors.bold(pad(c, widths[i]!))).join("  "));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(
      cols.map((c, i) => pad(String(row[c] ?? ""), widths[i]!)).join("  "),
    );
  }
}

// ── Agent URL / API key resolution ──────────────────────────────────────

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLocalAgentUrl(agentUrl: string): boolean {
  try {
    const u = new URL(agentUrl);
    return LOCAL_AGENT_HOSTS.has(normalizeHost(u.hostname));
  } catch {
    return false;
  }
}

export function getAgentUrl(opts?: { agentUrl?: string }): string {
  const raw =
    opts?.agentUrl?.trim() ||
    process.env.AGENT_URL ||
    process.env.AGENT_BASE_URL ||
    DEFAULT_AGENT_URL;
  return raw.replace(/\/+$/, "");
}

function readApiKeyFromConfig(): string | undefined {
  try {
    const dir =
      process.env.VIBECONTROLS_HOME ??
      join(process.cwd(), ".boff", "vibecontrols");
    const profile = process.env.VIBECONTROLS_PROFILE ?? "default";
    const cfgPath = join(resolvePath(dir), "agents", profile, "config.json");
    if (!existsSync(cfgPath)) return undefined;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      "static-api-key"?: string;
    };
    return cfg["static-api-key"];
  } catch {
    return undefined;
  }
}

export function authHeaders(): Record<string, string> {
  const env = process.env.AGENT_API_KEY ?? process.env.X_AGENT_API_KEY;
  if (env) return { "x-agent-api-key": env };
  const fromCfg = readApiKeyFromConfig();
  return fromCfg ? { "x-agent-api-key": fromCfg } : {};
}

// ── Fetch helpers ───────────────────────────────────────────────────────

async function jsonOrText(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json().catch(() => ({}));
  }
  return await res.text().catch(() => "");
}

async function request<T>(
  agentUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
    ...authHeaders(),
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${agentUrl}${path}`, { ...init, headers });
  const data = await jsonOrText(res);
  if (!res.ok) {
    const msg =
      (typeof data === "object" &&
        data !== null &&
        ((data as Record<string, unknown>).error ??
          (data as Record<string, unknown>).message)) ||
      `Agent returned ${res.status}`;
    throw new Error(String(msg));
  }
  return data as T;
}

export async function apiGet<T = unknown>(
  agentUrl: string,
  path: string,
): Promise<T> {
  return request<T>(agentUrl, path);
}

export async function apiPost<T = unknown>(
  agentUrl: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(agentUrl, path, {
    method: "POST",
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export async function apiPut<T = unknown>(
  agentUrl: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(agentUrl, path, {
    method: "PUT",
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export async function apiDelete<T = unknown>(
  agentUrl: string,
  path: string,
): Promise<T> {
  return request<T>(agentUrl, path, { method: "DELETE" });
}

export function formatStatus(status: string | undefined | null): string {
  if (!status) return "-";
  const s = status.toLowerCase();
  if (s === "completed" || s === "success" || s === "ok") {
    return colors.green(status);
  }
  if (s === "failed" || s === "error") {
    return colors.red(status);
  }
  if (s === "pending" || s === "running") {
    return colors.yellow(status);
  }
  return colors.gray(status);
}
