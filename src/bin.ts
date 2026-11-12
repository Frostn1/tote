#!/usr/bin/env bun
// tote                → MCP server over stdio (what Claude Desktop / Claude Code / Cursor run)
// tote serve          → MCP server over HTTP for claude.ai and the Claude phone app
// tote <command> …    → the command line (signin, search, cart, orders, …)
import { parseArgs } from "node:util";

if (process.argv[2] === "--help" || process.argv[2] === "-h") process.argv[2] = "help";
const [first] = process.argv.slice(2);

if (first === undefined || first === "stdio") {
  await import("./mcp.ts");
} else if (first === "serve") {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      port: { type: "string", default: process.env.AMAZON_MCP_PORT ?? "8765" },
      "public-url": { type: "string" },
      local: { type: "boolean" },
      "new-url": { type: "boolean" },
      market: { type: "string" },
    },
  });
  const { AmazonClient } = await import("./client.ts");
  const { serve, serveInstructions } = await import("./serve.ts");
  const client = new AmazonClient({
    marketplace: ((values.market ?? process.env.AMAZON_MARKETPLACE) as "us" | "uk") ?? "us",
    ...(process.env.AMAZON_SESSION_FILE ? { sessionFile: process.env.AMAZON_SESSION_FILE } : {}),
  });
  const publicUrl = values["public-url"] ?? process.env.AMAZON_MCP_PUBLIC_URL;
  if (!values.local && !publicUrl) console.error("Opening a secure tunnel…");
  const s = await serve(client, { port: Number(values.port), publicUrl, local: values.local, rotate: values["new-url"] });
  console.log(serveInstructions(s.url, { local: values.local, quickTunnel: !publicUrl }));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (s.stop(), process.exit(0)));
} else {
  await import("./cli.ts");
}
