// `basketly serve`: the same MCP server over HTTP, so claude.ai and the Claude phone app can use it
// as a custom connector. It listens on 127.0.0.1 only; a tunnel (or your own URL) makes it reachable.
// The endpoint path holds a long random secret, so the URL itself is the key: every other path is a 404.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AmazonClient } from "./client.ts";
import { AGENT_HOME } from "./http.ts";
import { createServer } from "./server.ts";
import { openTunnel } from "./tunnel.ts";

const SERVE_FILE = join(AGENT_HOME, "serve.json");
/** Open connector sessions kept at once; the oldest is dropped beyond this. */
const MAX_SESSIONS = 16;

/** The endpoint secret: made once, then reused so the connector URL path stays the same across restarts. */
export function endpointSecret(rotate = false): string {
  if (!rotate && existsSync(SERVE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(SERVE_FILE, "utf8")).secret;
      if (typeof s === "string" && /^[0-9a-f]{32}$/.test(s)) return s;
    } catch {}
  }
  const secret = randomBytes(16).toString("hex");
  mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(SERVE_FILE, JSON.stringify({ secret }), { mode: 0o600 });
  return secret;
}

/** The HTTP handler: Streamable HTTP MCP at `/mcp/<secret>`, one MCP session per connector connection. */
export function mcpHandler(client: AmazonClient, secret: string, { linkEnabled = true } = {}) {
  const path = `/mcp/${secret}`;
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const json = (status: number, message: string) =>
    Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });

  return async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== path) return new Response("Not found", { status: 404 });

    const id = req.headers.get("mcp-session-id");
    if (id) {
      const t = sessions.get(id);
      return t ? t.handleRequest(req) : json(404, "Session not found");
    }
    if (req.method !== "POST") return json(400, "No session");
    const body = await req.json().catch(() => null);
    if (!isInitializeRequest(body)) return json(400, "No session: send initialize first");

    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
        if (sessions.size > MAX_SESSIONS) {
          const [oldest] = sessions.keys();
          sessions.get(oldest!)?.close();
          sessions.delete(oldest!);
        }
      },
      onsessionclosed: (sid) => void sessions.delete(sid),
    });
    await createServer(client, { linkEnabled }).connect(transport);
    return transport.handleRequest(req, { parsedBody: body });
  };
}

export interface ServeOptions {
  port: number;
  /** Your own URL that already routes to the port (Tailscale Funnel, your domain…). Skips the tunnel. */
  publicUrl?: string;
  /** Don't open a tunnel: only this computer can reach it. */
  local?: boolean;
  rotate?: boolean;
}

export async function serve(client: AmazonClient, opts: ServeOptions): Promise<{ url: string; stop(): void }> {
  const secret = endpointSecret(opts.rotate);
  const http = Bun.serve({ hostname: "127.0.0.1", port: opts.port, idleTimeout: 0, fetch: mcpHandler(client, secret, { linkEnabled: !/^(off|0|false|no)$/i.test(process.env.AMAZON_SIGNIN_LINK ?? "") }) });
  const local = `http://127.0.0.1:${http.port}`;
  const tunnel = opts.local ? null : opts.publicUrl ? { url: opts.publicUrl.replace(/\/$/, ""), close() {} } : await openTunnel(http.port!, { publicUrl: null });
  const url = `${tunnel?.url ?? local}/mcp/${secret}`;
  return {
    url,
    stop() {
      tunnel?.close();
      http.stop(true);
    },
  };
}

export function serveInstructions(url: string, { local = false, quickTunnel = true } = {}): string {
  if (local) return [`Basketly is running at:`, ``, `  ${url}`, ``, `Only this computer can reach it (--local).`].join("\n");
  return [
    `Basketly is online. Your connector URL:`,
    ``,
    `  ${url}`,
    ``,
    `Add it once:  claude.ai → Settings → Connectors → Add custom connector → paste the URL.`,
    `Then it works in Claude on the web and in the Claude iPhone / Android app.`,
    ``,
    `Keep this window open (and the computer awake). The URL is a password: don't share it.`,
    ...(quickTunnel
      ? [`The address changes each time you restart. For a fixed one, use --public-url (see README → "Use it from your phone").`]
      : []),
  ].join("\n");
}
