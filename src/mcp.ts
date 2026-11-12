#!/usr/bin/env bun
// MCP server over stdio — for apps on this computer (Claude Desktop, Claude Code, Cursor, …).
// For the Claude phone app / claude.ai, see serve.ts (`tote serve`).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AmazonClient } from "./client.ts";
import { createServer } from "./server.ts";

const client = new AmazonClient({
  marketplace: (process.env.AMAZON_MARKETPLACE as "us" | "uk") ?? "us",
  ...(process.env.AMAZON_SESSION_FILE ? { sessionFile: process.env.AMAZON_SESSION_FILE } : {}),
});

/** The link opens a public tunnel to this machine, so agents may only use it when the owner enabled it. */
const linkEnabled = /^(on|1|true|yes)$/i.test(process.env.AMAZON_SIGNIN_LINK ?? "");

await createServer(client, { linkEnabled }).connect(new StdioServerTransport());
