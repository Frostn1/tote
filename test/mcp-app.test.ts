// The MCP App wiring, checked over a real stdio connection (no Amazon traffic: listing tools and
// reading resources never hits the network).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VIEW_URI } from "../src/view.ts";

let client: Client;

beforeAll(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [new URL("../src/mcp.ts", import.meta.url).pathname],
      env: { ...process.env, AMAZON_SESSION_FILE: "/tmp/tote-app-test.json" } as Record<string, string>,
    }),
  );
});
afterAll(() => client?.close());

describe("MCP App", () => {
  test("result tools point at the shop view; others don't", async () => {
    const { tools } = await client.listTools();
    const ui = (name: string) => (tools.find((t) => t.name === name)?._meta as any)?.ui?.resourceUri;
    for (const name of ["amazon_search", "amazon_product", "amazon_cart_add", "amazon_cart_view", "amazon_cart_remove"]) {
      expect(ui(name)).toBe(VIEW_URI);
    }
    for (const name of ["amazon_suggest", "amazon_signin", "amazon_session_status"]) expect(ui(name)).toBeUndefined();
  });

  test("placing an order and accepting terms are card-only tools; preview is visible to the model", async () => {
    const { tools } = await client.listTools();
    const meta = (name: string) => (tools.find((t) => t.name === name)?._meta as any)?.ui;
    expect(meta("amazon_order_place")?.visibility).toEqual(["app"]);
    expect(meta("amazon_accept_terms")?.visibility).toEqual(["app"]);
    expect(meta("amazon_order_preview")?.visibility).toBeUndefined();
    expect(meta("amazon_order_preview")?.resourceUri).toBe(VIEW_URI);
  });

  test("amazon_order_buy needs a signed-in account (guest session) and orders nothing", async () => {
    const r = (await client.callTool({ name: "amazon_order_buy", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("needs the user's own Amazon account");
  });

  test("server instructions cover photos, other stores and browser limits", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toContain("PHOTOS:");
    expect(text).toContain("OTHER STORES");
    expect(text).toMatch(/never type card numbers, passwords/);
    expect(text).toMatch(/never press the final buy/);
    expect(text).toMatch(/CAPTCHA/);
  });

  test("the view resource is an MCP App HTML page allowed to load Amazon images", async () => {
    const res = await client.readResource({ uri: VIEW_URI });
    const c = res.contents[0] as any;
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c._meta.ui.csp.resourceDomains).toEqual(["https://m.media-amazon.com"]);
    expect(c.text).toContain("globalThis.McpApps=");
    expect(c.text).toContain("app.ontoolresult = draw");
    expect(c.text).not.toContain("unpkg.com"); // SDK client is inlined, no CDN
    expect((c.text.match(/<\/script/gi) ?? []).length).toBe(2); // SDK client + view code, separate scopes
  });
});
