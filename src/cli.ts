#!/usr/bin/env bun
// bun run cli <command> …  — readable output by default, --json for raw data.
import { parseArgs } from "node:util";
import { AmazonClient, type Sort } from "./client.ts";
import { cartSummary, productCard, searchList, signInLinkText, signInText, statusText } from "./format.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    page: { type: "string" },
    sort: { type: "string" },
    filters: { type: "string" },
    min: { type: "string" },
    max: { type: "string" },
    dept: { type: "string" },
    qty: { type: "string" },
    market: { type: "string" },
    json: { type: "boolean" },
    link: { type: "boolean" },
  },
});

const client = new AmazonClient({
  marketplace: (values.market as "us" | "uk") ?? "us",
  ...(process.env.AMAZON_SESSION_FILE ? { sessionFile: process.env.AMAZON_SESSION_FILE } : {}),
});
const [cmd, sub, ...rest] = positionals;
const num = (s?: string) => (s == null ? undefined : Number(s));

const usage = `usage:
  basketly                    run the MCP server (stdio) — what your agent app starts
  basketly serve [--port 8765] [--public-url URL] [--local] [--new-url]
                              MCP over HTTP for claude.ai and the Claude phone app
  basketly signin [--link] | status | signout     (--link: one-time URL to sign in from your phone)
  basketly suggest <prefix> [--dept electronics]
  basketly search <query> [--page N] [--sort price-asc-rank] [--filters rh,rh] [--min 10] [--max 50]
  basketly product <asin|url>
  basketly cart view | add <asin|url> [--qty N] | remove <asin|url>
  basketly orders | track [orderId]
  basketly watch [list] | add <asin> <price> | remove <asin> | check
  basketly session reset            (guest mode only)
  add --json to any command for raw data`;

async function main(): Promise<[unknown, string]> {
  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      return [null, usage];
    case "signin": {
      if (!values.link) {
        console.error("A browser window is opening — sign in to Amazon there (5 min timeout)…");
        const o = await client.signIn();
        return [o, signInText(o)];
      }
      const link = await client.signInLink();
      if (link.alreadySignedIn) return [link, signInLinkText(link)];
      console.error(signInLinkText(link) + "\n\nWaiting for you to sign in…");
      const o = (await client.waitForSignIn())!;
      return [o, signInText(o)];
    }
    case "status": {
      const s = await client.verifyStatus();
      return [s, statusText(s)];
    }
    case "signout":
      await client.signOut();
      return [{ ok: true }, "Signed out here."];
    case "suggest": {
      const s = await client.suggest([sub, ...rest].join(" "), { dept: values.dept });
      return [s, s.join("\n")];
    }
    case "search": {
      const r = await client.search([sub, ...rest].join(" "), {
        page: num(values.page),
        sort: values.sort as Sort,
        filters: values.filters,
        minPrice: num(values.min),
        maxPrice: num(values.max),
        dept: values.dept,
      });
      return [r, searchList(r, 20)];
    }
    case "product": {
      const p = await client.product(sub!);
      return [p, productCard(p)];
    }
    case "cart": {
      const hint = client.guestHint;
      if (sub === "add") {
        const c = await client.addToCart(rest[0]!, num(values.qty));
        return [c, cartSummary(c, { added: c.items.find((i) => rest[0]!.toUpperCase().includes(i.asin))?.asin, hint })];
      }
      if (sub === "remove") {
        const c = await client.removeFromCart(rest[0]!);
        return [c, cartSummary(c, { removed: rest[0], hint })];
      }
      const c = await client.viewCart();
      return [c, cartSummary(c, { hint })];
    }
    case "orders": {
      const { ordersText } = await import("./format.ts");
      const list = await client.orders();
      return [list, ordersText(list)];
    }
    case "track": {
      const { trackingText } = await import("./format.ts");
      const r = await client.track(sub);
      return [r, trackingText(r.order, r.tracking)];
    }
    case "watch": {
      const { watchText } = await import("./format.ts");
      if (sub === "add") { await client.watch(rest[0]!, Number(rest[1])); return [client.watchlist, watchText(client.watchlist)]; }
      if (sub === "remove") { client.unwatch(rest[0]!); return [client.watchlist, watchText(client.watchlist)]; }
      if (sub === "check") {
        const r = await client.checkWatches();
        // One line per hit, for the morning health check's push alert.
        const lines = r.hits.map((w) => `PRICE DROP: ${w.title.slice(0, 60)} is $${w.lastPrice?.toFixed(2)} (your target $${w.below.toFixed(2)}) — say "buy the ${w.title.split(/[ ,]/)[0]}" to order`);
        return [r, lines.length ? lines.join("\n") : `No price drops (${r.checked.length} watched${r.failed.length ? `, ${r.failed.length} couldn't be checked` : ""}).`];
      }
      return [client.watchlist, watchText(client.watchlist)];
    }
    case "session":
      await client.resetSession();
      return [{ ok: true }, "Started a fresh guest session."];
    default:
      console.error(usage);
      process.exit(1);
  }
}

try {
  const [data, text] = await main();
  console.log(values.json ? JSON.stringify(data, null, 2) : text);
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
