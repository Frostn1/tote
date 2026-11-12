// The MCP server: every tool, the shop view and the instructions. Transports live in mcp.ts (stdio) and serve.ts (HTTP).
// Each tool returns: a readable markdown summary → product images → compact JSON data.
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { buyWithConfirmation } from "./buy.ts";
import { type AmazonClient, SORTS, type SearchOptions, type SignInVia } from "./client.ts";
import { cartSummary, orderPlacedText, orderSummary, ordersText, productCard, searchList, signInLinkText, signInText, statusText, trackingText, watchText } from "./format.ts";
import { fetchImage } from "./http.ts";
import { VIEW_IMAGE_DOMAINS, VIEW_META_KEY, VIEW_URI, viewHtml, type ViewKind } from "./view.ts";

type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function images(list: { url: string | null; caption?: string }[], size: number): Promise<Block[]> {
  const got = await Promise.all(list.map(async (i) => (i.url ? { caption: i.caption, img: await fetchImage(i.url, size) } : null)));
  const out: Block[] = [];
  for (const g of got) {
    if (!g?.img) continue;
    if (g.caption) out.push({ type: "text", text: g.caption });
    out.push({ type: "image", data: g.img.data, mimeType: g.img.mimeType });
  }
  return out;
}

/**
 * Every result: markdown summary → images → `data: {json}` (all text-only hosts, e.g. Claude Code).
 * With `view`, the MCP App view's payload also rides in `_meta` (hosts that render the UI read it;
 * text-only hosts ignore it, so their output doesn't change).
 */
function reply(summary: string, data: unknown, imgs: Block[] = [], view?: ViewKind) {
  return {
    content: [{ type: "text" as const, text: summary }, ...imgs, { type: "text" as const, text: `data: ${JSON.stringify(data)}` }] as Block[],
    ...(view ? { _meta: { [VIEW_META_KEY]: { kind: view, data } } } : {}),
  };
}

/** Tools whose results render in the shop view. */
const withView = { _meta: { ui: { resourceUri: VIEW_URI } } };

const run = <A,>(fn: (a: A) => Promise<{ content: Block[]; _meta?: Record<string, unknown> }>) => async (a: A) => {
  try {
    return await fn(a);
  } catch (e) {
    const err = e as Error;
    return { isError: true, content: [{ type: "text" as const, text: `${err.name}: ${err.message}` }] };
  }
};
const asin = z.string().describe("ASIN (e.g. B0FB2WX15J) or any Amazon product URL");

/** Build a server around one Amazon client. `linkEnabled`: whether amazon_signin may open the public sign-in link. */
export function createServer(client: AmazonClient, { linkEnabled }: { linkEnabled: boolean }): McpServer {
const LINK_ENABLED = linkEnabled;
const server = new McpServer(
  { name: "tote", version: pkg.version },
  {
    instructions: [
      "USE THESE TOOLS for anything involving Amazon or buying a product for the user: finding products, comparing prices, \"add to my cart\", checking the cart. They talk to Amazon directly with the user's own signed-in session and return product cards with photos and prices.",
      "Do NOT open or drive a web browser (Claude in Chrome, computer use, the built-in browser) to shop on Amazon or add to the user's Amazon cart: these tools already do it, faster and without CAPTCHAs or browser prompts. If the user says \"my cart\" without naming a store, assume Amazon and use these tools.",
      "Typical flow: amazon_search (with maxPrice/sort for budgets like \"under $20\") → pick by rating and review count → amazon_cart_add. Use amazon_product for details, amazon_cart_view to show the cart.",
      "Each result starts with a markdown summary and product images: show those to the user, not the JSON (the JSON is for your reasoning).",
      "In apps that render MCP Apps (e.g. Claude chat), search, product and cart results also appear as interactive cards with photos, prices and Add to cart / Remove buttons — don't repeat the whole list in text; give a short pick and why.",
      "Cart tools act on the user's own Amazon cart once they are signed in; otherwise on an anonymous guest cart. Check amazon_session_status; if not signed in (or a tool says the sign-in expired), call amazon_signin and send the user the link it returns — the USER signs in on Amazon's real page. Never ask for their password.",
      "BLOCKS: if a tool says Amazon blocked or challenged a request, stop and tell the user. Don't retry, don't reset the session to get around it.",
      "ORDERS & ALERTS: amazon_orders (history, reorder), amazon_track (where's my package), amazon_watch (\"tell me when X drops under $Y\"; checked daily with a push alert).",
      "OPTIONS: for products with sizes/colours (amazon_product shows 🎛️ options), ask the user's choice for clothing/shoes, then use amazon_variant or amazon_cart_add with options.",
      "BUYING: you CAN place orders for the user. When they want to buy, tick the right items (amazon_cart_select) and call amazon_order_buy — the app then shows THEM a confirmation dialog (items, address, card, total) and the order is placed only if they accept. Don't tell the user you can't check out, and don't ask them to type yes in chat: offer \"Want me to buy it? You'll get a confirmation to approve.\" If amazon_order_buy says the app can't show the dialog, show the order card (amazon_order_preview: they press Place order) or give the Checkout link. Nothing is ever bought without their confirmation.",
      "PHOTOS: when the user shares a picture of something they want (\"find this shirt\"): look closely — brand, logo, visible text or tags, item type, colour, material, pattern/print, cut. Say what you think it is and how sure you are. Then search Amazon with amazon_search using a precise query (brand + item + key details); if you know or can find the brand's own website, check it too (see OTHER STORES). Show the closest matches side by side and say which looks like an exact match vs. a similar alternative. For clothing and shoes, ask the size (and colour if unclear) before adding to a cart.",
      "OTHER STORES (not Amazon): these tools only cover Amazon. For any other store, use your browser tool if you have one (Claude in Chrome, or the app's built-in browser), working in the open so the user can watch: search the store, open the product, pick the options the user chose, add it to the store's cart, open the cart and STOP there. Then tell the user what's in that cart (item, options, price) and that they finish checkout themselves on that site (e.g. Shop Pay / Apple Pay).",
      "BROWSER LIMITS (other stores): never type card numbers, passwords, one-time codes or addresses; never press the final buy / place-order / pay button; never create accounts; never try to get past a CAPTCHA, bot check or \"are you a robot\" page — stop and hand it to the user. If a site blocks you or needs sign-in, say so and give the user the product link. Prefer Amazon (these tools) when the same item is sold there and the user doesn't mind where it comes from.",
    ].join("\n"),
  },
);

server.registerTool(
  "amazon_suggest",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Autocomplete: Amazon's search suggestions for a partial query. Use to refine vague queries.",
    inputSchema: { prefix: z.string(), dept: z.string().optional().describe("Department alias, e.g. electronics; default all"), limit: z.number().int().min(1).max(11).optional() },
  },
  run(async (a: { prefix: string; dept?: string; limit?: number }) => {
    const s = await client.suggest(a.prefix, a);
    return reply(s.length ? `Suggestions for "${a.prefix}": ${s.map((x) => `\`${x}\``).join(", ")}` : `No suggestions for "${a.prefix}".`, s);
  }),
);

registerAppTool(
  server,
  "amazon_search",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    ...withView,
    description:
      "Search Amazon for products (use this instead of a browser for any Amazon or shopping request, e.g. \"find me pens under $20\" → query \"pens\", maxPrice 20, sort review-rank). For \"a good X\", use sort review-rank and recommend 1-3 picks. Returns the top 8 by default (limit to change) as a readable result list with thumbnails of the top results, plus JSON. Page 1 also returns `refinements` (filters) in the JSON; pass their `rh` values (comma-joined) as `filters` to narrow. Sponsored results are flagged.",
    inputSchema: {
      query: z.string(),
      page: z.number().int().min(1).optional(),
      sort: z.enum(SORTS).optional(),
      filters: z.string().optional().describe('rh values from refinements, e.g. "p_72:1248915011,p_123:486782"'),
      minPrice: z.number().optional(),
      maxPrice: z.number().optional(),
      dept: z.string().optional(),
      includeSponsored: z.boolean().optional().describe("Default true"),
      images: z.number().int().min(0).max(10).optional().describe("Thumbnails for the top N results (default 5, 0 = none)"),
      limit: z.number().int().min(1).max(60).optional().describe("How many results to return (default 8). Keep it small; raise only if the user wants to browse more"),
      offset: z.number().int().min(0).max(59).optional().describe("Skip this many results on the page (used by the card's Show more)"),
    },
  },
  run(async (a: { query: string; includeSponsored?: boolean; images?: number; limit?: number; offset?: number } & SearchOptions) => {
    const r = await client.search(a.query, a);
    if (a.includeSponsored === false) r.results = r.results.filter((x) => !x.sponsored);
    // A short list reads better in chat (and costs fewer tokens); the card's "Show more" pages through the rest.
    const offset = a.offset ?? 0;
    const limit = a.limit ?? 8;
    const onPage = r.results.length;
    r.results = r.results.slice(offset, offset + limit);
    Object.assign(r, { offset, limit, moreOnPage: onPage > offset + limit });
    const n = a.images ?? 5;
    const thumbs = await images(
      r.results.slice(0, n).map((x, i) => ({ url: x.image, caption: `${i + 1}. ${x.title.slice(0, 70)}` })),
      200,
    );
    return reply(searchList(r), r, thumbs, "search");
  }),
);

registerAppTool(
  server,
  "amazon_product",
  {
    annotations: { readOnlyHint: true, openWorldHint: true }, ...withView, description: "Product details as a readable card with the product image: title, price, rating, availability, highlights.", inputSchema: { asin } },
  run(async (a: { asin: string }) => {
    const p = await client.product(a.asin);
    return reply(productCard(p), p, await images([{ url: p.images[0] ?? null }], 500), "product");
  }),
);

registerAppTool(
  server,
  "amazon_variant",
  {
    ...withView,
    annotations: { readOnlyHint: true, openWorldHint: true },
    description:
      'Pick options on a product with sizes/colours/styles, e.g. {"size":"medium","color":"navy"}. Returns that exact version (its own price, stock and photo) and the full option list. Matching is forgiving ("med", "navy"); if a value is ambiguous you get the choices back — ask the user.',
    inputSchema: { asin, choose: z.record(z.string(), z.string()) },
  },
  run(async (a: { asin: string; choose: Record<string, string> }) => {
    const p = await client.productVariant(a.asin, a.choose);
    return reply(productCard(p), p, await images([{ url: p.images[0] ?? null }], 500), "product");
  }),
);

registerAppTool(
  server,
  "amazon_cart_add",
  {
    annotations: { destructiveHint: false, openWorldHint: true },
    ...withView,
    description:
      "Add a product to the user's Amazon cart (their own cart when signed in, else a guest cart) — use this, not a browser, whenever the user asks to add something to their cart. Adding doesn't buy; to buy, use amazon_order_buy. Returns a confirmation with the product image and the updated cart.",
    inputSchema: {
      asin,
      quantity: z.number().int().min(1).max(30).optional().describe("Only to add MORE of an item. Omit it: if the item is already in the cart, nothing is added"),
      options: z.record(z.string(), z.string()).optional().describe('Size/colour/etc. for listings with options, e.g. {"size":"M","color":"black 7 pack"}. For clothing/shoes, ask the user first.'),
    },
  },
  run(async (a: { asin: string; quantity?: number; options?: Record<string, string> }) => {
    const cart = await client.addToCart(a.asin, a.quantity, a.options);
    const added = cart.items.find((i) => a.asin.toUpperCase().includes(i.asin));
    return reply(cartSummary(cart, { added: added?.asin, hint: client.guestHint }), { ...cart, added: added?.asin }, await images([{ url: added?.image ?? null }], 300), "cart");
  }),
);

registerAppTool(
  server,
  "amazon_cart_view",
  {
    annotations: { readOnlyHint: true, openWorldHint: true }, ...withView, description: "Show the cart: items with thumbnails, subtotal, and a link to open it.", inputSchema: {} },
  run(async () => {
    const cart = await client.viewCart();
    return reply(cartSummary(cart, { hint: client.guestHint }), cart, await images(cart.items.slice(0, 5).map((i) => ({ url: i.image })), 160), "cart");
  }),
);

registerAppTool(
  server,
  "amazon_cart_select",
  {
    ...withView,
    description:
      "Tick or untick items in the user's Amazon cart. Amazon only checks out ticked items, so use this when the user picks which items to buy. Returns the cart with the new subtotal and a Checkout link (the user places the order on Amazon).",
    inputSchema: { asins: z.array(asin).min(1).max(50), selected: z.boolean().describe("true = tick (include in checkout), false = untick") },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  run(async (a: { asins: string[]; selected: boolean }) => {
    const cart = await client.selectCartItems(a.asins, a.selected);
    return reply(cartSummary(cart, { hint: client.guestHint }), cart, [], "cart");
  }),
);

registerAppTool(
  server,
  "amazon_cart_remove",
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true }, ...withView, description: "Remove a product from the cart.", inputSchema: { asin } },
  run(async (a: { asin: string }) => {
    const cart = await client.removeFromCart(a.asin);
    return reply(cartSummary(cart, { removed: a.asin, hint: client.guestHint }), { ...cart, removed: a.asin }, [], "cart");
  }),
);

server.registerTool(
  "amazon_signin",
  {
    description: [
      "Get the user signed in to Amazon (or past a security check) so cart tools use their own cart; guest-cart items are moved over.",
      'via "link" (only if the server owner set AMAZON_SIGNIN_LINK=on; then the default): returns a one-time link at once — send it to the user; they open it on their phone or any computer and sign in on Amazon\'s real page. It expires in 10 minutes and locks to the first device. Then check amazon_session_status (or call again with wait:true) to confirm.',
      'via "window" (default when the link is off): opens a browser window on the computer running this server and waits — only when the user is sitting at that computer.',
      "Never ask the user for their password.",
    ].join(" "),
    inputSchema: {
      via: z.enum(["link", "window"]).optional(),
      wait: z.boolean().optional().describe('With via "link": wait (up to 10 min) for the user to finish instead of returning the link right away'),
    },
  },
  run(async (a: { via?: SignInVia; wait?: boolean }) => {
    const via = a.via ?? (process.env.AMAZON_SIGNIN_VIA as SignInVia | undefined) ?? (LINK_ENABLED ? "link" : "window");
    if (via === "link" && !LINK_ENABLED) {
      throw new Error(
        'The sign-in link is off. It opens a public tunnel to this computer for up to 10 minutes, so it must be enabled when the server is installed: set AMAZON_SIGNIN_LINK=on in the MCP server\'s environment. Or use via:"window" if the user is at this computer.',
      );
    }
    if (via === "window") {
      const o = await client.signIn();
      return reply(signInText(o), o);
    }
    if (a.wait) {
      const done = await client.waitForSignIn();
      if (done) return reply(signInText(done), done);
    }
    const link = await client.signInLink();
    return reply(signInLinkText(link), link);
  }),
);

server.registerTool(
  "amazon_session_status",
  { annotations: { readOnlyHint: true, openWorldHint: true }, description: "Whether the user is signed in (their own cart) or on a guest cart. Checks with Amazon that the sign-in is still valid.", inputSchema: {} },
  run(async () => {
    const s = await client.verifyStatus();
    return reply(statusText(s), s);
  }),
);

server.registerTool(
  "amazon_signout",
  { description: "Forget the Amazon sign-in on this computer (session cookies and the sign-in browser profile).", inputSchema: {} },
  run(async () => {
    await client.signOut();
    return reply("Signed out here. Cart actions now use a guest cart.", { ok: true });
  }),
);

server.registerTool(
  "amazon_session_reset",
  { description: "Guest mode only: start a fresh anonymous session (clears the guest cart). Only when the user asks for it. Never use it to get around a block or CAPTCHA.", inputSchema: {} },
  run(async () => {
    await client.resetSession();
    return reply("Started a fresh guest session.", { ok: true });
  }),
);

// ── ordering ──────────────────────────────────────────────────────────────────────────────────
// The model can prepare an order; only the user can place it. amazon_order_place and
// amazon_accept_terms are app-only (hidden from the model in MCP Apps hosts) AND need a one-time
// code that travels only in _meta to the card — never in text the model reads.

registerAppTool(
  server,
  "amazon_order_preview",
  {
    ...withView,
    annotations: { readOnlyHint: true, openWorldHint: true },
    description:
      "Show the order for the ticked cart items as an order card: items, delivery address, payment method (brand + last 4), delivery and total, read from Amazon's own order page. Nothing is ordered. The USER places the order by pressing Place order in the card (you cannot); if the host can't run card buttons, they use the Checkout link instead.",
    inputSchema: {},
  },
  run(async () => {
    const o = await client.previewOrder();
    const { token: _token, ...forModel } = o;
    // Also a typed confirmation code (card-only), for apps where the card's buttons can't run.
    const code = client.issueConfirmationCode(o.token, o.totalText!, !o.termsAccepted);
    return {
      content: [
        { type: "text" as const, text: orderSummary(forModel) },
        {
          type: "text" as const,
          text: "If the card's buttons don't work in this app, the card also shows a 6-digit code: the user can type it here (e.g. \"confirm 123456\") and you call amazon_order_confirm with it. You don't know the code.",
        },
        { type: "text" as const, text: `data: ${JSON.stringify(forModel)}` },
      ],
      _meta: { [VIEW_META_KEY]: { kind: "order", data: { ...o, code } } },
    };
  }),
);

registerAppTool(
  server,
  "amazon_order_buy",
  {
    ...withView,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: [
      "Buy the ticked cart items when the user asks you to (\"buy it\", \"order it\"). The app shows the user a confirmation dialog with the items, address, card and total;",
      "the order is placed ONLY if they accept it there. You cannot confirm for them: don't ask them to type yes in chat, call this and let the dialog ask.",
      "Tick the right items first (amazon_cart_select). If the app can't show the dialog, tell the user to use the order card's Place order button or Checkout on Amazon.",
    ].join(" "),
    inputSchema: {},
  },
  run(async () => {
    const canAsk = !!server.server.getClientCapabilities()?.elicitation;
    const out = await buyWithConfirmation(
      client,
      canAsk
        ? async (message, schema) => {
            const r = await server.server.elicitInput({ mode: "form", message, requestedSchema: schema } as Parameters<typeof server.server.elicitInput>[0]);
            return { action: r.action, content: r.content as Record<string, unknown> | undefined };
          }
        : null,
    );
    if (out.placed) return reply(orderPlacedText(out.order), out.order, [], "placed" as ViewKind);
    if ("needsCode" in out) {
      // The code goes ONLY to the card (_meta). The model is told a code exists, never what it is.
      return {
        content: [
          {
            type: "text" as const,
            text: [
              orderSummary(out.preview),
              "",
              "This app couldn't show a confirmation dialog, so the order card now shows the user a 6-digit confirmation code.",
              "Ask them to type it here to buy (e.g. \"confirm 123456\"), then call amazon_order_confirm with what they typed. You don't know the code and must not guess it.",
            ].join("\n"),
          },
          { type: "text" as const, text: `data: ${JSON.stringify({ ...out.preview, awaitingCode: true })}` },
        ],
        _meta: { [VIEW_META_KEY]: { kind: "confirm", data: { ...out.preview, code: out.code } } },
      };
    }
    return reply(`Not ordered — ${out.reason}`, { placed: false, reason: out.reason });
  }),
);

registerAppTool(
  server,
  "amazon_order_confirm",
  {
    ...withView,
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description:
      "Place the order waiting for confirmation, using the 6-digit code the USER typed from their order card. Pass exactly what they typed. Never invent or guess a code: 3 wrong tries cancel the order.",
    inputSchema: { code: z.string().min(1).max(40).describe("The confirmation code exactly as the user typed it") },
  },
  run(async (a: { code: string }) => {
    const r = await client.confirmWithCode(a.code);
    return reply(orderPlacedText(r), r, [], "placed" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_order_place",
  {
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Order card only: places the order the user confirmed. Requires the card's one-time code and the exact total shown.",
    inputSchema: { token: z.string().length(32), expectedTotal: z.string() },
  },
  run(async (a: { token: string; expectedTotal: string }) => {
    const r = await client.placeOrder(a.token, a.expectedTotal);
    return reply(orderPlacedText(r), r, [], "placed" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_accept_terms",
  {
    _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Order card only: records that the user pressed I agree on the ordering terms (TERMS.md).",
    inputSchema: { token: z.string().length(32) },
  },
  run(async (a: { token: string }) => {
    client.acceptTerms(a.token);
    return reply("The user accepted the ordering terms.", { termsAccepted: true });
  }),
);

// ── Your orders & price alerts ────────────────────────────────────────────────────────────

registerAppTool(
  server,
  "amazon_orders",
  {
    ...withView,
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "The user's recent Amazon orders: date, total, delivery status and items (read-only). Use for \"what did I order\", \"reorder X\" (then amazon_cart_add with the item's ASIN) and to find an order to track.",
    inputSchema: {},
  },
  run(async () => {
    const list = await client.orders();
    return reply(ordersText(list), { orders: list }, [], "orders" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_track",
  {
    ...withView,
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Where's my package: delivery estimate, current step (Ordered → Shipped → Out for delivery → Delivered) and tracking ID. Pass an order number, or omit it for the most recent order.",
    inputSchema: { orderId: z.string().optional() },
  },
  run(async (a: { orderId?: string }) => {
    const r = await client.track(a.orderId);
    return reply(trackingText(r.order, r.tracking), r, [], "tracking" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_watch",
  {
    ...withView,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Price-drop alert: watch a product and alert the user (daily check, push notification) when it's at or below a price. Also use to change the target.",
    inputSchema: { asin, below: z.number().positive().describe("Alert at or below this price (dollars)") },
  },
  run(async (a: { asin: string; below: number }) => {
    await client.watch(a.asin, a.below);
    return reply(watchText(client.watchlist), { watchlist: client.watchlist }, [], "watch" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_unwatch",
  {
    ...withView,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Stop watching a product's price.",
    inputSchema: { asin },
  },
  run(async (a: { asin: string }) => {
    client.unwatch(a.asin);
    return reply(watchText(client.watchlist), { watchlist: client.watchlist }, [], "watch" as ViewKind);
  }),
);

registerAppTool(
  server,
  "amazon_watchlist",
  {
    ...withView,
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: "Show watched products with current price, target and lowest seen. refresh:true re-checks prices now.",
    inputSchema: { refresh: z.boolean().optional() },
  },
  run(async (a: { refresh?: boolean }) => {
    const hits = a.refresh ? (await client.checkWatches()).hits : client.watchlist.filter((w) => w.lastPrice != null && w.lastPrice <= w.below);
    return reply(watchText(client.watchlist, hits), { watchlist: client.watchlist, hits }, [], "watch" as ViewKind);
  }),
);

registerAppResource(
  server,
  "Amazon shop view",
  VIEW_URI,
  { description: "Product cards, product details and cart, with images, prices and cart buttons" },
  async () => ({
    contents: [
      {
        uri: VIEW_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: viewHtml(),
        _meta: { ui: { csp: { resourceDomains: VIEW_IMAGE_DOMAINS }, prefersBorder: true } },
      },
    ],
  }),
);
return server;
}
