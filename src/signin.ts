// Interactive sign-in. The USER signs in (email, password, OTP, CAPTCHA) on Amazon's own page;
// this code never reads or fills the form — it only waits for the account cookies, then copies them.
//
// Two ways to show that page:
//   window — a visible Chromium window on this computer
//   link   — headless Chromium streamed to a one-time URL (phone / any computer), see liveview.ts
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { AGENT_HOME, isCaptcha, withAgentTag, type AccountInfo, type Session } from "./http.ts";
import { startLiveView } from "./liveview.ts";
import { openTunnel } from "./tunnel.ts";

export const BROWSER_PROFILE = join(AGENT_HOME, "browser");
const ACCOUNT_COOKIE = /^(at|sess-at|x)-(main|acbuk)$/;
export const LINK_TTL_MS = 10 * 60_000;

const ASSOC_HANDLE: Record<string, string> = { "www.amazon.com": "usflex", "www.amazon.co.uk": "gbflex" };

function signInUrl(host: string) {
  const q = new URLSearchParams({
    "openid.pape.max_auth_age": "0",
    "openid.return_to": `https://${host}/`,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.assoc_handle": ASSOC_HANDLE[host] ?? "usflex",
    "openid.mode": "checkid_setup",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.ns": "http://specs.openid.net/auth/2.0",
  });
  return `https://${host}/ap/signin?${q}`;
}

export interface SignInResult {
  account: AccountInfo;
  /** True when the browser profile was already signed in and no input was needed. */
  reused: boolean;
}

/** Only one sign-in at a time: both flows share the persistent browser profile. */
let busy = false;
function claim() {
  if (busy) throw new Error("A sign-in is already in progress.");
  busy = true;
}

// ── shared steps ─────────────────────────────────────────────────────────────

async function launch(headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless,
    viewport: headless ? { width: 1000, height: 800 } : null,
    args: headless ? [] : ["--window-size=1100,900"],
  });
}

/** Seed the browser with the client's latest cookies, open Amazon, go to sign-in if needed. */
async function prepare(ctx: BrowserContext, page: Page, session: Session): Promise<boolean> {
  const host = session.mp.host;
  const jar = session.cookieHeader();
  if (jar && session.signedIn) {
    await ctx.addCookies(
      jar.split("; ").map((p) => {
        const i = p.indexOf("=");
        return { name: p.slice(0, i), value: p.slice(i + 1), domain: `.${host.replace(/^www\./, "")}`, path: "/", secure: true };
      }),
    );
  }
  await page.goto(`https://${host}/`, { waitUntil: "domcontentloaded" });
  const reused = (await greeting(page)) !== null && !isCaptcha(await safeContent(page));
  if (!reused && !isCaptcha(await safeContent(page))) await page.goto(signInUrl(host), { waitUntil: "domcontentloaded" });
  return reused;
}

/** Poll until the account cookies exist and the nav greets the user; then hand cookies to the session. */
async function waitForSignIn(
  ctx: BrowserContext,
  page: Page,
  session: Session,
  { deadline, stopped, userAgent }: { deadline: number; stopped: () => string | null; userAgent?: string },
): Promise<AccountInfo> {
  const host = session.mp.host;
  for (;;) {
    const why = stopped();
    if (why) throw new Error(why);
    if (Date.now() > deadline) throw new Error("Timed out waiting for the user to sign in.");
    const jar = await ctx.cookies(`https://${host}/`).catch(() => []);
    if (jar.some((c) => ACCOUNT_COOKIE.test(c.name))) {
      // Account cookies exist: let Amazon decide whether they're good, whatever page the browser
      // shows. On mobile, sign-in often ends on an extra /ap/ screen (passkey offer, add phone,
      // approve notification) — the user is done, so don't wait for them to leave it.
      // Checked with the client's own desktop request, which also reads the greeting reliably.
      const cookies = Object.fromEntries(jar.map((c) => [c.name, c.value]));
      // Store the browser's real desktop identity for the HTTP client.
      const ua = userAgent ?? (await page.evaluate(() => navigator.userAgent));
      const name = await confirmedName(host, cookies, ua);
      if (name !== null) {
        const account: AccountInfo = { name: name || null, signedInAt: new Date().toISOString() };
        session.adoptAccount(cookies, account, ua);
        return account;
      }
      await Bun.sleep(2000); // not accepted yet (mid-redirect, or a step still pending) — don't hammer Amazon
    }
    await Bun.sleep(1000);
  }
}

/**
 * Load Amazon's desktop home page with these cookies and read the nav greeting.
 * "Alex" when signed in, "" when signed in without a readable name, null when not signed in.
 */
export async function confirmedName(host: string, cookies: Record<string, string>, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}/`, {
      headers: {
        "User-Agent": withAgentTag(userAgent),
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html",
        Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    return greetingName(await res.text());
  } catch {
    return null;
  }
}

/** Parse the desktop nav greeting from page HTML (exported for tests). */
export function greetingName(html: string): string | null {
  const m = html.match(/nav-link-accountList-nav-line-1"[^>]*>\s*([^<]*)</);
  const text = m?.[1]?.trim();
  if (!text || /sign in/i.test(text)) return null;
  return text.replace(/^Hello,\s*/i, "");
}

/** "Hello, Alex" → "Alex"; "" when signed in without a readable name; null when signed out. */
async function greeting(page: Page): Promise<string | null> {
  const text = (await page.locator("#nav-link-accountList-nav-line-1").first().textContent({ timeout: 3000 }).catch(() => null))?.trim();
  if (!text || /sign in/i.test(text)) return null;
  return text.replace(/^Hello,\s*/i, "");
}

async function safeContent(page: Page) {
  return page.content().catch(() => "");
}

// ── window flow ──────────────────────────────────────────────────────────────

/** Visible window on this computer. Resolves once signed in; rejects on timeout or window close. */
export async function interactiveSignIn(session: Session, { timeoutMs = 5 * 60_000 } = {}): Promise<SignInResult> {
  claim();
  const ctx = await launch(false).catch((e) => {
    busy = false;
    throw e;
  });
  let closed = false;
  ctx.on("close", () => {
    closed = true;
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const reused = await prepare(ctx, page, session);
    if (!reused) await page.bringToFront();
    const account = await waitForSignIn(ctx, page, session, {
      deadline: Date.now() + timeoutMs,
      stopped: () => (closed ? "The sign-in window was closed before signing in." : null),
    });
    return { account, reused };
  } finally {
    busy = false;
    if (!closed) await ctx.close().catch(() => {});
  }
}

// ── link flow ────────────────────────────────────────────────────────────────

/**
 * Amazon-only navigation for the remote browser: top-level pages must be Amazon,
 * sub-resources may also come from Amazon's CDNs and its CAPTCHA/WAF hosts.
 */
const AMAZON_PAGE = /(^|\.)amazon\.(com|co\.uk|de|fr|it|es|ca|com\.mx|com\.br|in|co\.jp|com\.au|ae|nl|pl|se|sg)$/;
const AMAZON_ASSET = /(^|\.)(media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com|amazon-adsystem\.com|a2z\.com|awswaf\.com|cloudfront\.net|amazonaws\.com)$/;

export function allowedRequest(url: string, isNavigation: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:") return !isNavigation;
  if (u.protocol !== "https:") return false;
  if (AMAZON_PAGE.test(u.hostname)) return true;
  return !isNavigation && AMAZON_ASSET.test(u.hostname);
}

export interface LinkSignIn {
  url: string;
  expiresAt: Date;
  /** Settles when the user has signed in (or the link expired / was cancelled). */
  done: Promise<SignInResult>;
  cancel(): void;
}

/**
 * Start a remote sign-in: headless browser + live view server + tunnel.
 * Returns as soon as the link is reachable; `done` resolves after the user signs in.
 */
export async function startLinkSignIn(session: Session, { ttlMs = LINK_TTL_MS } = {}): Promise<LinkSignIn> {
  claim();
  const expiresAt = new Date(Date.now() + ttlMs);
  const token = randomBytes(32).toString("base64url");
  let ctx: BrowserContext | undefined;
  let view: Awaited<ReturnType<typeof startLiveView>> | undefined;
  let tunnel: Awaited<ReturnType<typeof openTunnel>> | undefined;
  let stopReason: string | null = null;

  const cleanup = async () => {
    view?.close();
    tunnel?.close();
    await ctx?.close().catch(() => {});
    busy = false;
  };

  try {
    ctx = await launch(true);
    await ctx.route("**/*", (route) => {
      const req = route.request();
      const nav = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
      return allowedRequest(req.url(), nav) ? route.continue() : route.abort("blockedbyclient");
    });
    // Popups would escape the live view: load them in the main tab instead (if allowed).
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    ctx.on("page", async (p) => {
      if (p === page) return;
      const target = p.url();
      await p.close().catch(() => {});
      if (target && allowedRequest(target, true)) await page.goto(target).catch(() => {});
    });
    const ua = await page.evaluate(() => navigator.userAgent);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: withAgentTag(ua) });

    const reused = await prepare(ctx, page, session);
    if (reused) {
      // Already signed in — no link needed.
      const account = await waitForSignIn(ctx, page, session, { deadline: Date.now() + 30_000, stopped: () => null, userAgent: ua });
      await cleanup();
      return { url: "", expiresAt, done: Promise.resolve({ account, reused: true }), cancel() {} };
    }

    view = startLiveView({ page, cdp, token, expiresAt, desktopUa: ua, port: Number(process.env.AMAZON_SIGNIN_PORT) || 0 });
    tunnel = await openTunnel(view.port);
    const url = `${tunnel.url.replace(/\/$/, "")}/s/${token}`;

    const done = (async () => {
      try {
        const account = await waitForSignIn(ctx!, page, session, {
          deadline: expiresAt.getTime(),
          stopped: () => stopReason,
          userAgent: ua,
        });
        view!.finish(account.name);
        await Bun.sleep(1500); // let the success screen reach the user
        return { account, reused: false };
      } finally {
        await cleanup();
      }
    })();
    done.catch(() => {}); // callers may not await it

    return {
      url,
      expiresAt,
      done,
      cancel() {
        stopReason = "Sign-in link cancelled.";
      },
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/** Delete the persistent browser profile (part of sign-out). */
export function clearBrowserProfile() {
  rmSync(BROWSER_PROFILE, { recursive: true, force: true });
}
