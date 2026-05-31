/**
 * Ungit Reverse Proxy
 *
 * Proxies all requests from /git/* to the local Ungit instance.
 * Handles:
 *   - Session cookie authentication (Ungit internal requests can't send API key headers)
 *   - HTTP reverse proxying with streaming
 *   - WebSocket bridging for socket.io (Ungit uses socket.io for real-time updates)
 *   - Header stripping (X-Frame-Options, CSP) to allow iframe embedding
 */

import { Elysia } from "elysia";

// -- Session Management -----------------------------------------------------

interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const COOKIE_NAME = "__vibe_ungit_session";

// -- URL/header sanitisation helpers ----------------------------------------
//
// The `apiKey` query param is a credential meant only for the proxy
// boundary — upstream tools (Ungit here) must never see it. We also strip
// the Referer header for the same reason: it can leak the apiKey when the
// browser navigated from a URL that carried `?apiKey=`.

/**
 * Return `url.search` with any `apiKey` param (case-insensitive) removed.
 * Returns "" if no params remain, or "?…" otherwise.
 */
function searchWithoutApiKey(url: URL): string {
  const sp = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    const lower = k.toLowerCase();
    // Strip apiKey + vt iframe-token before forwarding upstream — both are
    // proxy-boundary credentials and must never reach Ungit.
    if (lower === "apikey" || lower === "vt") continue;
    sp.append(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * For mutating requests authenticated by a session cookie, require an
 * Origin or Referer that matches the proxy's own host. CSRF shield —
 * cookie is SameSite=None for iframe embedding so the browser will send
 * it on cross-site requests; the origin check is what blocks them.
 */
function originAllowed(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return true;

  const proxyHost = new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === proxyHost;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host === proxyHost;
    } catch {
      return false;
    }
  }
  return false;
}

const sessions = new Map<string, Session>();

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function createSession(): Session {
  const token = generateSessionToken();
  const now = Date.now();
  const session: Session = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return session;
}

function validateSessionToken(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Clean up expired sessions periodically */
function cleanupSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupSessions, 10 * 60 * 1000);

/**
 * Extract a cookie value from the Cookie header.
 */
function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

// -- Auth helpers -----------------------------------------------------------

function isAuthed(
  request: Request,
  validateApiKey: (key: string) => boolean,
  validateIframeToken: (token: string, path: string) => boolean,
): { hasValidSession: boolean; hasValidApiKey: boolean } {
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = getCookie(cookieHeader, COOKIE_NAME);
  const apiKeyHeader = request.headers.get("x-agent-api-key");
  const url = new URL(request.url);
  const apiKeyParam = url.searchParams.get("apiKey");
  // audit-B P0-SEC-03 residual — the microfe mints a single-use iframe token
  // scoped to `/git` and appends it as `?vt=<token>` for the entry document
  // (header injection is unavailable for top-level navigation). The proxy
  // accepts it once to bootstrap the session cookie, after which sub-
  // requests reuse the cookie.
  const vtParam = url.searchParams.get("vt");
  const vtHeader =
    request.headers.get("x-vibe-iframe-token") ??
    request.headers.get("X-Vibe-Iframe-Token");
  const vtToken = vtHeader ?? vtParam;

  const hasValidSession = sessionToken
    ? validateSessionToken(sessionToken)
    : false;

  // Check apiKey from: header, query param, or Referer URL (for iframe sub-resources
  // where third-party cookies are blocked and the apiKey was in the parent iframe URL)
  let hasValidApiKey =
    (apiKeyHeader != null && validateApiKey(apiKeyHeader)) ||
    (apiKeyParam != null && validateApiKey(apiKeyParam));

  if (!hasValidApiKey && !hasValidSession && vtToken) {
    // Iframe-token verify is scoped to the `/git` prefix. The agent's
    // verifier checks signature + expiry + single-use JTI + prefix cover.
    if (validateIframeToken(vtToken, url.pathname)) {
      hasValidApiKey = true;
    }
  }

  if (!hasValidApiKey && !hasValidSession) {
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const refKey = refUrl.searchParams.get("apiKey");
        if (refKey && validateApiKey(refKey)) {
          hasValidApiKey = true;
        }
      } catch {
        // Invalid referer URL
      }
    }
  }

  return { hasValidSession, hasValidApiKey };
}

// -- Path helpers -----------------------------------------------------------

function stripPrefix(pathname: string): string {
  // With --rootPath /git, Ungit handles the /git prefix itself.
  // Pass the path through without stripping.
  return pathname || "/";
}

// -- Headers to strip from proxied responses (for iframe embedding) ---------

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "x-content-type-options",
]);

// -- Create proxy -----------------------------------------------------------

/**
 * Create the reverse proxy Elysia instance.
 *
 * @param getPort - Returns the port Ungit is running on, or null if not running
 * @param validateApiKey - Validates an API key string against the agent's key
 */
export function createUngitProxy(
  getPort: () => number | null,
  validateApiKey: (key: string) => boolean,
  validateIframeToken: (token: string, path: string) => boolean = () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // WebSocket bridge is intentionally disabled: Elysia's .ws() handler
  // intercepts socket.io HTTP long-polling requests, breaking the transport.
  // Socket.io falls back to HTTP polling which works through .all() proxy.
  return new Elysia({ prefix: "/git" })
    .all("/*", async ({ request }) => {
      return handleProxyRequest(
        request,
        getPort,
        validateApiKey,
        validateIframeToken,
      );
    })
    .all("/", async ({ request }) => {
      return handleProxyRequest(
        request,
        getPort,
        validateApiKey,
        validateIframeToken,
      );
    });
}

async function handleProxyRequest(
  request: Request,
  getPort: () => number | null,
  validateApiKey: (key: string) => boolean,
  validateIframeToken: (token: string, path: string) => boolean,
): Promise<Response> {
  const { hasValidSession, hasValidApiKey } = isAuthed(
    request,
    validateApiKey,
    validateIframeToken,
  );

  if (!hasValidSession && !hasValidApiKey) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized -- provide a valid API key or session",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // CSRF guard for cookie-authed mutating requests.
  if (!hasValidApiKey && hasValidSession && !originAllowed(request)) {
    return new Response(
      JSON.stringify({ error: "Forbidden -- invalid Origin" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // If authenticated via API key but no session cookie, create session and
  // serve the proxied content directly (with Set-Cookie header).
  let sessionCookieHeader: string | null = null;
  if (!hasValidSession && hasValidApiKey) {
    const session = createSession();
    sessionCookieHeader = `${COOKIE_NAME}=${session.token}; Path=/git/; HttpOnly; SameSite=None; Secure; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  // Verify Ungit is running
  const port = getPort();
  if (!port) {
    return new Response(JSON.stringify({ error: "Ungit is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await handleHttpProxy(request, port);

  // Attach the session cookie to the proxied response
  if (sessionCookieHeader) {
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", sessionCookieHeader);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

/**
 * Proxy an HTTP request to the local Ungit instance.
 */
async function handleHttpProxy(
  request: Request,
  port: number,
): Promise<Response> {
  const url = new URL(request.url);
  const strippedPath = stripPrefix(url.pathname);
  // Strip apiKey from query before forwarding — it's a proxy-boundary
  // credential and must never reach Ungit.
  const sanitisedSearch = searchWithoutApiKey(url);
  const upstreamUrl = `http://127.0.0.1:${port}${strippedPath}${sanitisedSearch}`;

  // Build upstream headers (copy most, skip hop-by-hop)
  const upstreamHeaders = new Headers();
  const hopByHopHeaders = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    // Drop Referer — it may carry `?apiKey=` from the parent iframe URL.
    "referer",
  ]);

  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  });

  // Override Host header for Ungit
  upstreamHeaders.set("Host", `127.0.0.1:${port}`);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? request.body
          : undefined,
      redirect: "manual",
    });

    // Build response headers, stripping iframe-blocking ones
    const responseHeaders = new Headers();
    upstreamResponse.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Ensure HTML responses have correct content-type (ungit sends application/octet-stream)
    // Only check the root path to avoid consuming response bodies of other endpoints
    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (strippedPath === "/git/" && !contentType.includes("text/html")) {
      const body = await upstreamResponse.text();
      if (
        body.trimStart().startsWith("<!DOCTYPE") ||
        body.trimStart().startsWith("<html")
      ) {
        responseHeaders.set("content-type", "text/html; charset=utf-8");
        responseHeaders.delete("content-length");
        return new Response(body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: responseHeaders,
        });
      }
      // Body was consumed but wasn't HTML, return it as-is
      return new Response(body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to proxy to Ungit",
        details: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export default createUngitProxy;
