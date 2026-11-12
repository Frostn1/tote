// `tote serve`: the HTTP endpoint answers MCP only on the secret path. No Amazon traffic here.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AmazonClient } from "../src/client.ts";
import { mcpHandler } from "../src/serve.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const client = new AmazonClient({ sessionFile: join(mkdtempSync(join(tmpdir(), "amz-serve-")), "s.json"), minIntervalMs: 0 });
const handle = mcpHandler(client, SECRET);
const base = "http://127.0.0.1:8787";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const init = rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });

/** Reads a JSON-RPC result from a JSON or SSE response. */
async function result(r: Response) {
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}

describe("serve endpoint", () => {
  test("the secret path speaks MCP and lists the tools", async () => {
    const r1 = await handle(new Request(`${base}/mcp/${SECRET}`, { method: "POST", headers, body: init }));
    expect(r1.status).toBe(200);
    const sid = r1.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    expect((await result(r1)).result.serverInfo.name).toBe("tote");

    const h = { ...headers, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" };
    await handle(new Request(`${base}/mcp/${SECRET}`, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }));
    const r2 = await handle(new Request(`${base}/mcp/${SECRET}`, { method: "POST", headers: h, body: rpc(2, "tools/list") }));
    const names = (await result(r2)).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("amazon_search");
    expect(names).toContain("amazon_order_buy");
  });

  test("any other path is a 404, including the root and a wrong secret", async () => {
    for (const p of ["/", "/mcp", `/mcp/${"f".repeat(32)}`, `/mcp/${SECRET}/x`]) {
      const r = await handle(new Request(`${base}${p}`, { method: "POST", headers, body: init }));
      expect(r.status).toBe(404);
    }
  });

  test("an unknown session is refused; a request without one must be initialize", async () => {
    const r1 = await handle(new Request(`${base}/mcp/${SECRET}`, { method: "POST", headers: { ...headers, "mcp-session-id": "nope" }, body: rpc(2, "tools/list") }));
    expect(r1.status).toBe(404);
    const r2 = await handle(new Request(`${base}/mcp/${SECRET}`, { method: "POST", headers, body: rpc(2, "tools/list") }));
    expect(r2.status).toBe(400);
  });
});
