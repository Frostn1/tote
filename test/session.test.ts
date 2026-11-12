import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TAG, BlockedError, PurchaseBlockedError, Session, SignInRequiredError } from "../src/http.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake Amazon home page that hands out a new session-id on every call. */
function fakeHome() {
  let n = 0;
  globalThis.fetch = (async () =>
    new Response("<html></html>", {
      headers: { "content-type": "text/html", "set-cookie": `session-id=new-${++n}; Path=/` },
    })) as unknown as typeof fetch;
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "amz-")), "session.json");

describe("Session ledger", () => {
  test("reads v1 flat cookie files and writes v2 { cookies, cart }", async () => {
    fakeHome();
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ "session-id": "old", "ubid-main": "u" }));
    const s = new Session({ sessionFile: f, minIntervalMs: 0 });
    expect(s.hasSession).toBe(true);
    s.setCart([{ asin: "B0FB2WX15J", quantity: 2 }]);
    const saved = JSON.parse(readFileSync(f, "utf8"));
    expect(saved.cookies["session-id"]).toBe("old");
    expect(saved.cart).toEqual([{ asin: "B0FB2WX15J", quantity: 2 }]);
    expect(new Session({ sessionFile: f }).cart).toEqual([{ asin: "B0FB2WX15J", quantity: 2 }]);
  });

  test("renew replays the ledger into the new session", async () => {
    fakeHome();
    const s = new Session({ sessionFile: tmpFile(), minIntervalMs: 0 });
    s.setCart([{ asin: "B0FB2WX15J", quantity: 1 }, { asin: "B07VQS7SSC", quantity: 2 }]);
    const replayed: unknown[] = [];
    s.onRenew = async (ledger) => {
      replayed.push(...ledger);
    };
    await s.renew();
    expect(s.cookieHeader()).toContain("session-id=new-1");
    expect(replayed).toEqual([{ asin: "B0FB2WX15J", quantity: 1 }, { asin: "B07VQS7SSC", quantity: 2 }]);
  });

  test("renew({ keepCart: false }) clears the ledger and skips replay", async () => {
    fakeHome();
    const s = new Session({ sessionFile: tmpFile(), minIntervalMs: 0 });
    s.setCart([{ asin: "B0FB2WX15J", quantity: 1 }]);
    let called = false;
    s.onRenew = async () => {
      called = true;
    };
    await s.renew({ keepCart: false });
    expect(called).toBe(false);
    expect(s.cart).toEqual([]);
  });

  test("no nested renewal while replaying", async () => {
    fakeHome();
    const s = new Session({ sessionFile: tmpFile(), minIntervalMs: 0 });
    s.setCart([{ asin: "B0FB2WX15J", quantity: 1 }]);
    let calls = 0;
    s.onRenew = async () => {
      calls++;
      await s.renew(); // would recurse forever without the guard
    };
    await s.renew();
    expect(calls).toBe(1);
  });
});

describe("Session account mode", () => {
  test("account cookies → account mode", () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, cart: [], account: { name: "Alex", signedInAt: "x" } }));
    const s = new Session({ sessionFile: f });
    expect(s.mode).toBe("account");
    expect(s.account?.name).toBe("Alex");
    expect(new Session({ sessionFile: tmpFile() }).mode).toBe("guest");
  });

  test("session file is private (0600)", () => {
    const f = tmpFile();
    new Session({ sessionFile: f }).setCart([]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  test("a block in account mode never drops the cookies", async () => {
    globalThis.fetch = (async () => new Response("captcha", { status: 503, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, lastUsed: Date.now() }));
    const s = new Session({ sessionFile: f, minIntervalMs: 0 });
    await expect(s.request("https://www.amazon.com/dp/B0FB2WX15J")).rejects.toThrow(BlockedError);
    expect(s.cookieHeader()).toContain("at-main=tok");
  });

  test("signed-out page in account mode → SignInRequiredError", async () => {
    globalThis.fetch = (async () =>
      new Response('<span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, sign in</span>', {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, lastUsed: Date.now() }));
    await expect(new Session({ sessionFile: f, minIntervalMs: 0 }).request("https://www.amazon.com/gp/cart/view.html")).rejects.toThrow(SignInRequiredError);
  });
});

describe("Session guest blocks", () => {
  test("a guest block makes exactly one fetch and throws without renewing", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("captcha", { status: 503, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const s = new Session({ sessionFile: null, minIntervalMs: 0 });
    await expect(s.request("https://www.amazon.com/s?k=pen")).rejects.toThrow(BlockedError);
    expect(calls).toBe(1);
    expect(s.hasSession).toBe(false);
  });
});

describe("purchase guard", () => {
  test.each([
    "https://www.amazon.com/gp/buy/spc/handlers/display.html",
    "https://www.amazon.com/checkout/entry/cart",
    "https://www.amazon.com/gp/cart/desktop/go-to-checkout.html",
  ])("refuses %s", async (url) => {
    let sent = false;
    globalThis.fetch = (async () => {
      sent = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(new Session({ sessionFile: null }).request(url)).rejects.toThrow(PurchaseBlockedError);
    expect(sent).toBe(false);
  });

  test("refuses a redirect into checkout", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "/checkout/entry" } })) as unknown as typeof fetch;
    await expect(new Session({ sessionFile: null, minIntervalMs: 0 }).request("https://www.amazon.com/cart/add-to-cart")).rejects.toThrow(PurchaseBlockedError);
  });
});

describe("verifyStatus", () => {
  const accountFile = () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, account: { name: "Alex", signedInAt: "x" }, lastUsed: Date.now() }));
    return f;
  };
  const page = (greeting: string) =>
    (async () =>
      new Response(`<span id="nav-link-accountList-nav-line-1" class="nav-line-1">${greeting}</span>`, {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

  test("valid sign-in → signInValid true", async () => {
    globalThis.fetch = page("Hello, Alex");
    const { AmazonClient } = await import("../src/client.ts");
    const s = await new AmazonClient({ sessionFile: accountFile(), minIntervalMs: 0 }).verifyStatus();
    expect(s).toMatchObject({ mode: "account", signedInAs: "Alex", signInValid: true });
  });

  test("expired sign-in → signInValid false (not an error)", async () => {
    globalThis.fetch = page("Hello, sign in");
    const { AmazonClient } = await import("../src/client.ts");
    const s = await new AmazonClient({ sessionFile: accountFile(), minIntervalMs: 0 }).verifyStatus();
    expect(s).toMatchObject({ mode: "account", signInValid: false });
  });

  test("guest mode makes no request", async () => {
    let called = false;
    globalThis.fetch = (async () => ((called = true), new Response(""))) as unknown as typeof fetch;
    const { AmazonClient } = await import("../src/client.ts");
    const s = await new AmazonClient({ sessionFile: tmpFile(), minIntervalMs: 0 }).verifyStatus();
    expect(s).toMatchObject({ mode: "guest", signInValid: null });
    expect(called).toBe(false);
  });
});

describe("agent identification", () => {
  test("every request carries the fixed agent tag", async () => {
    let ua = "";
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      ua = (init.headers as Record<string, string>)["User-Agent"]!;
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    await new Session({ sessionFile: null, minIntervalMs: 0 }).request("https://www.amazon.com/s?k=pen", { raw: true });
    expect(ua).toContain("Chrome/");
    expect(AGENT_TAG).toStartWith("tote/1.1 (AI shopping agent; +https://github.com/Frostn1/tote");
    expect(ua).toContain(AGENT_TAG);
  });

  test("the tag is added once", async () => {
    const { withAgentTag } = await import("../src/http.ts");
    expect(withAgentTag(withAgentTag("Mozilla/5.0 X"))).toBe(withAgentTag("Mozilla/5.0 X"));
  });
});

describe("cart selection", () => {
  const fixture = () => Bun.file(new URL("./fixtures/cart.html", import.meta.url)).text();
  const accountFile = () => {
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, lastUsed: Date.now() }));
    return f;
  };

  test("unticking posts Amazon's selection action with the item id and CSRF token", async () => {
    const html = (await fixture()).replace('data-itemtype="active"', 'data-itemtype="active" data-isSelected="1"').replace('Hello, sign in', 'Hello, Alex');
    const posts: { url: string; body: string; csrf: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") posts.push({ url, body: String(init.body), csrf: (init.headers as Record<string, string>)["anti-csrftoken-a2z"]! });
      return new Response(html, { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const { AmazonClient } = await import("../src/client.ts");
    await new AmazonClient({ sessionFile: accountFile(), minIntervalMs: 0 }).selectCartItems(["B0FB2WX15J"], false);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://www.amazon.com/cart/ref=ox_sc_cart_actions_1");
    const form = new URLSearchParams(posts[0]!.body);
    const action = JSON.parse(form.get("actionPayload")!)[0];
    expect(action.type).toBe("UPDATE_ITEM_SELECTION_START");
    expect(action.payload).toMatchObject({ itemId: "7370b56b-e115-4703-a73d-2445cc1048f0", list: "activeItems", isSelected: false });
    expect(posts[0]!.csrf).toBeTruthy();
    expect(form.get("anti-csrftoken-a2z")).toBe(posts[0]!.csrf);
  });

  test("already in the wanted state → no request", async () => {
    const html = (await fixture()).replace('data-itemtype="active"', 'data-itemtype="active" data-isSelected="1"').replace('Hello, sign in', 'Hello, Alex');
    let posts = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => ((posts += init.method === "POST" ? 1 : 0), new Response(html, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    const { AmazonClient } = await import("../src/client.ts");
    await new AmazonClient({ sessionFile: accountFile(), minIntervalMs: 0 }).selectCartItems(["B0FB2WX15J"], true);
    expect(posts).toBe(0);
  });

  test("guest carts can't tick items", async () => {
    const html = await fixture(); // guest fixture: no selection state
    globalThis.fetch = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const { AmazonClient } = await import("../src/client.ts");
    await expect(new AmazonClient({ sessionFile: tmpFile(), minIntervalMs: 0 }).selectCartItems(["B0FB2WX15J"], false)).rejects.toThrow(/signed-in cart/);
  });
});

describe("checkout link", () => {
  test("checks out only the ticked items (partial cart)", async () => {
    const { checkoutUrlFor } = await import("../src/client.ts");
    const u = new URL(checkoutUrlFor("https://www.amazon.com", 2));
    expect(u.pathname).toBe("/checkout/entry/cart");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ proceedToCheckout: "1", partialCheckoutCart: "1", useDefaultCart: "1", cartItemCount: "2" });
  });
});

describe("add to cart", () => {
  test("an item already in the cart isn't added again unless a quantity is asked for", async () => {
    const html = (await Bun.file(new URL("./fixtures/cart.html", import.meta.url)).text()).replace("Hello, sign in", "Hello, Alex");
    let posts = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => ((posts += init.method === "POST" ? 1 : 0), new Response(html, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    const f = tmpFile();
    writeFileSync(f, JSON.stringify({ cookies: { "session-id": "s", "at-main": "tok" }, lastUsed: Date.now() }));
    const { AmazonClient } = await import("../src/client.ts");
    const cart = await new AmazonClient({ sessionFile: f, minIntervalMs: 0 }).addToCart("B0FB2WX15J");
    expect(cart.alreadyInCart).toBe("B0FB2WX15J");
    expect(posts).toBe(0);
  });
});

describe("Amazon's interstitial challenge page", () => {
  test("counts as a block, not as an empty result list", async () => {
    const html = await Bun.file(new URL("./fixtures/challenge.html", import.meta.url)).text();
    const { isCaptcha } = await import("../src/http.ts");
    expect(isCaptcha(html)).toBe(true);
    globalThis.fetch = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const s = new Session({ sessionFile: null, minIntervalMs: 0 });
    await expect(s.request("https://www.amazon.com/s?k=pens")).rejects.toThrow(BlockedError);
  });

  test("a results page with zero cards and no 'No results' marker is an error", async () => {
    const { parseSearchPage } = await import("../src/parse.ts");
    expect(parseSearchPage("<html><body><div>something else</div></body></html>", "https://www.amazon.com").unexpected).toBe(true);
    expect(parseSearchPage("<html><body>No results for xyzzy.</body></html>", "https://www.amazon.com").unexpected).toBe(false);
  });
});
