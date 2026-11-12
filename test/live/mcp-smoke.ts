// Live smoke test: drives every non-interactive MCP tool against amazon.com in guest mode.
// Uses its own throwaway session file, so it never touches the user's signed-in session.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "smoke", version: "0" });
await c.connect(
  new StdioClientTransport({
    command: "bun",
    args: [new URL("../../src/mcp.ts", import.meta.url).pathname],
    env: { ...process.env, AMAZON_SESSION_FILE: "/tmp/tote-smoke-session.json" } as Record<string, string>,
  }),
);
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));

let failed = 0;
async function call(name: string, args: Record<string, unknown> = {}, expectError = false) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[]; _meta?: Record<string, any> };
  const imgs = r.content.filter((b) => b.type === "image");
  const summary = r.content[0]?.text ?? "";
  // MCP App: result tools carry the view payload in _meta, and still end with the text data block.
  const viewKind = { amazon_search: "search", amazon_product: "product", amazon_cart_add: "cart", amazon_cart_view: "cart", amazon_cart_remove: "cart" }[name];
  const viewOk = expectError || !viewKind || (r._meta?.["amazon-agent/view"]?.kind === viewKind && !!r.content.at(-1)?.text?.startsWith("data: "));
  const ok = !!r.isError === expectError && viewOk;
  if (!ok) failed++;
  console.log(`\n── ${name} ${ok ? "✓" : "✗"}${r.isError ? " (error)" : ""} · ${imgs.length} image(s) ${imgs.map((i) => `${Math.round((i.data!.length * 3) / 4 / 1024)}KB`).join(" ")}`);
  console.log(summary.split("\n").slice(0, 8).join("\n"));
  return r;
}

await call("amazon_session_status");
await call("amazon_suggest", { prefix: "gel pe", limit: 4 });
await call("amazon_search", { query: "fountain pen", maxPrice: 30, images: 3 });
await call("amazon_product", { asin: "https://www.amazon.com/dp/B0FB2WX15J?psc=1" });
await call("amazon_cart_add", { asin: "B0FB2WX15J" });
await call("amazon_cart_view");
await call("amazon_cart_remove", { asin: "B0FB2WX15J" });
await call("amazon_cart_remove", { asin: "B0FB2WX15J" }, true);
await c.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
