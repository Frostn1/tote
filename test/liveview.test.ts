import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { CDPSession, Page } from "playwright";
import { mobileIdentity, parseClientMsg, sameToken, startLiveView, type LiveView } from "../src/liveview.ts";
import { allowedRequest, greetingName } from "../src/signin.ts";

// Minimal stand-ins: the server only needs cdp.on/send and a few page methods.
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36";
const cdpCalls: [string, unknown][] = [];
const fakeCdp = { on() {}, send: async (m: string, p: unknown) => (cdpCalls.push([m, p]), {}) } as unknown as CDPSession;
const clicks: [number, number][] = [];
const fakePage = {
  mouse: { click: async (x: number, y: number) => void clicks.push([x, y]), wheel: async () => {}, move: async () => {} },
  reload: async () => {},
  evaluate: async () => "password",
  keyboard: { insertText: async () => {}, press: async () => {} },
  setViewportSize: async () => {},
} as unknown as Page;

let view: LiveView | undefined;
afterEach(() => view?.close());

function start(ttlMs = 60_000) {
  const token = randomBytes(32).toString("base64url");
  view = startLiveView({ page: fakePage, cdp: fakeCdp, token, expiresAt: new Date(Date.now() + ttlMs), desktopUa: DESKTOP_UA });
  return { token, base: `http://127.0.0.1:${view.port}` };
}

describe("live view link", () => {
  test("wrong or missing token → 404, health check is bare", async () => {
    const { base } = start();
    expect((await fetch(`${base}/s/${randomBytes(32).toString("base64url")}`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
  });

  test("link previews can't lock the link; the first live connection does", async () => {
    const { base, token } = start();
    const wsUrl = `ws://127.0.0.1:${view!.port}/s/${token}/ws`;
    const open: WebSocket[] = [];
    const connect = (cookie?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl, (cookie ? { headers: { cookie } } : {}) as unknown as string[]);
        let opened = false;
        ws.onopen = () => ((opened = true), open.push(ws), resolve(101));
        ws.onerror = () => resolve(403);
        ws.onclose = () => !opened && resolve(403);
      });

    // A chat app fetches the link to build a preview: it gets the page but never connects.
    const preview = await fetch(`${base}/s/${token}`);
    expect(preview.status).toBe(200);
    const previewCookie = preview.headers.get("set-cookie")!.split(";")[0]!;

    // The user's phone opens it afterwards — still allowed, and its live connection takes the lock.
    const phone = await fetch(`${base}/s/${token}`);
    expect(phone.status).toBe(200);
    const phoneCookie = phone.headers.get("set-cookie")!.split(";")[0]!;
    expect(phone.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    expect(await connect(phoneCookie)).toBe(101);

    // From now on everyone else is out: the preview's id, new visitors, forged or missing cookies.
    expect(await connect(previewCookie)).toBe(403);
    expect(await connect("lv=forged")).toBe(403);
    expect(await connect()).toBe(403);
    expect((await fetch(`${base}/s/${token}`)).status).toBe(403);
    expect((await fetch(`${base}/s/${token}`, { headers: { cookie: previewCookie } })).status).toBe(403);
    // The phone can still reload.
    expect((await fetch(`${base}/s/${token}`, { headers: { cookie: phoneCookie } })).status).toBe(200);
    open.forEach((ws) => ws.close());
  });

  test("a connection needs a visitor id from the page", async () => {
    const { token } = start();
    const res = await fetch(`http://127.0.0.1:${view!.port}/s/${token}/ws`, { headers: { cookie: "lv=made-up" } });
    expect(res.status).toBe(403);
  });

  test("viewer page headers", async () => {
    const { base, token } = start();
    const r = await fetch(`${base}/s/${token}`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    const html = await r.text();
    expect(html).not.toContain("<script>"); // every script carries the nonce
  });

  test("expired link → 410", async () => {
    const { base, token } = start(-1);
    expect((await fetch(`${base}/s/${token}`)).status).toBe(410);
  });

  test("the lock holder's socket drives the page", async () => {
    const { base, token } = start();
    const cookie = (await fetch(`${base}/s/${token}`)).headers.get("set-cookie")!.split(";")[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${view!.port}/s/${token}/ws`, { headers: { cookie } } as unknown as string[]);
    await new Promise((r) => (ws.onopen = r));
    clicks.length = 0;
    ws.send(JSON.stringify({ t: "tap", x: 120, y: 340 }));
    ws.send(JSON.stringify({ t: "tap", x: -5, y: 10 })); // rejected
    await Bun.sleep(100);
    expect(clicks).toEqual([[120, 340]]); // desktop viewer → mouse click

    // A phone viewer switches the remote browser to mobile emulation at the phone's density…
    cdpCalls.length = 0;
    ws.send(JSON.stringify({ t: "viewport", w: 390, h: 700, dpr: 3, mobile: true }));
    ws.send(JSON.stringify({ t: "tap", x: 50, y: 60 }));
    await Bun.sleep(100);
    const sent = Object.fromEntries(cdpCalls.map(([m, p]) => [m, p])) as Record<string, any>;
    expect(sent["Emulation.setDeviceMetricsOverride"]).toEqual({ width: 390, height: 700, deviceScaleFactor: 3, mobile: true });
    expect(sent["Emulation.setUserAgentOverride"].userAgent).toContain("Mobile Safari");
    // Frames are full-resolution screenshots (the screencast is only a change signal).
    expect(sent["Page.captureScreenshot"]).toMatchObject({ format: "jpeg" });
    // …and taps become touch events.
    expect(cdpCalls.filter(([m]) => m === "Input.dispatchTouchEvent")).toHaveLength(2);
    // After a tap the viewer is told what kind of field has focus (for autofill), never its value.
    const got: string[] = [];
    ws.onmessage = (e) => typeof e.data === "string" && got.push(e.data);
    ws.send(JSON.stringify({ t: "tap", x: 10, y: 10 }));
    await Bun.sleep(200);
    expect(got).toContain(JSON.stringify({ t: "focus", kind: "password" }));
    ws.close();
  });
});

describe("client messages", () => {
  test("only well-formed input passes", () => {
    expect(parseClientMsg('{"t":"text","text":"hello"}')).toEqual({ t: "text", text: "hello" });
    expect(parseClientMsg('{"t":"key","key":"Enter"}')).toEqual({ t: "key", key: "Enter" });
    expect(parseClientMsg('{"t":"key","key":"Meta+R"}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: "text", text: "x".repeat(513) }))).toBeNull();
    expect(parseClientMsg('{"t":"tap","x":"1","y":2}')).toBeNull();
    expect(parseClientMsg('{"t":"viewport","w":390,"h":700,"dpr":3,"mobile":true}')).toEqual({ t: "viewport", w: 390, h: 700, dpr: 3, mobile: true });
    expect(parseClientMsg('{"t":"viewport","w":390,"h":700,"dpr":9,"mobile":true}')).toBeNull();
    expect(parseClientMsg('{"t":"navigate","url":"https://evil.example"}')).toBeNull();
    expect(parseClientMsg("not json")).toBeNull();
    expect(parseClientMsg('{"t":"back","url":"https://evil.example"}')).toEqual({ t: "back" }); // extra fields ignored
  });

  test("mobile identity follows the desktop Chrome version", () => {
    const m = mobileIdentity(DESKTOP_UA);
    expect(m.userAgent).toStartWith("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36");
    expect(m.userAgent).toContain("AI shopping agent"); // the sign-in browser identifies itself too
    expect(m.userAgentMetadata).toMatchObject({ mobile: true, platform: "Android", fullVersion: "156.0.8078.4" });
    expect(m.userAgentMetadata.brands).toEqual([
      { brand: "Chromium", version: "156" },
      { brand: "Not?A_Brand", version: "99" },
    ]);
  });

  test("token compare", () => {
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
    expect(sameToken("abc", "abcd")).toBe(false);
  });
});

describe("remote browser allowlist", () => {
  test("pages must be Amazon", () => {
    expect(allowedRequest("https://www.amazon.com/ap/signin?x=1", true)).toBe(true);
    expect(allowedRequest("https://www.amazon.co.uk/", true)).toBe(true);
    expect(allowedRequest("https://evil.example/", true)).toBe(false);
    expect(allowedRequest("https://amazon.com.evil.example/", true)).toBe(false);
    expect(allowedRequest("http://www.amazon.com/", true)).toBe(false);
    expect(allowedRequest("https://bucket.s3.amazonaws.com/page.html", true)).toBe(false);
  });

  test("assets may come from Amazon CDNs and its captcha hosts", () => {
    expect(allowedRequest("https://m.media-amazon.com/images/I/x.jpg", false)).toBe(true);
    expect(allowedRequest("https://opfcaptcha-prod.s3.amazonaws.com/c.jpg", false)).toBe(true);
    expect(allowedRequest("https://captcha.awswaf.com/x.js", false)).toBe(true);
    expect(allowedRequest("https://www.google-analytics.com/a.js", false)).toBe(false);
  });
});

describe("sign-in confirmation", () => {
  test("reads the desktop greeting", () => {
    expect(greetingName('<span id="nav-link-accountList-nav-line-1" class="nav-line-1">Hello, Alex</span>')).toBe("Alex");
    expect(greetingName('<span id="nav-link-accountList-nav-line-1" class="nav-line-1 nav-progressive-content">Hello, sign in</span>')).toBeNull();
    expect(greetingName("<html>mobile layout without the desktop nav</html>")).toBeNull();
  });
});
