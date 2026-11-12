// Session layer: cookie jar, throttling, block detection, guest-session renewal,
// signed-in account mode with keep-alive, and a hard guard against purchase URLs.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Marketplace {
  host: string; // www.amazon.com
  completionHost: string; // completion.amazon.com
  mid: string; // marketplace id
  lang: string; // Accept-Language
}

export const MARKETPLACES: Record<string, Marketplace> = {
  us: { host: "www.amazon.com", completionHost: "completion.amazon.com", mid: "ATVPDKIKX0DER", lang: "en-US,en;q=0.9" },
  uk: { host: "www.amazon.co.uk", completionHost: "completion.amazon.co.uk", mid: "A1F83G8C2ARO7P", lang: "en-GB,en;q=0.9" },
};

/** Session file + sign-in browser profile live here. Override with AMAZON_AGENT_HOME (e.g. for tests). */
export const AGENT_HOME = process.env.AMAZON_AGENT_HOME ?? join(homedir(), ".amazon-agent");
export const DEFAULT_SESSION_FILE = join(AGENT_HOME, "session.json");

/**
 * Every request this client sends says it comes from Basketly, an AI shopping agent. The fixed tag
 * cannot be disabled or replaced; AMAZON_AGENT_TAG appends optional contact text.
 */
const FIXED_AGENT_TAG = "basketly/1.1 (AI shopping agent; +https://github.com/Frostn1/basketly)";
export const AGENT_TAG =
  process.env.AMAZON_AGENT_TAG === undefined
    ? FIXED_AGENT_TAG
    : `${FIXED_AGENT_TAG.slice(0, -1)}; contact: ${process.env.AMAZON_AGENT_TAG})`;

/** Append the agent tag to a browser user agent (idempotent). */
export function withAgentTag(ua: string): string {
  return ua.includes(AGENT_TAG) ? ua : `${ua} ${AGENT_TAG}`;
}

const DEFAULT_UA =
  "Mozilla/5.0 (compatible) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Cookies Amazon only sets for a signed-in account. */
const ACCOUNT_COOKIES = ["at-main", "sess-at-main", "x-main", "at-acbuk", "x-acbuk"];

/** The client must never reach checkout. Anything matching this is refused before it is sent. */
const PURCHASE_URL = /\/checkout|\/gp\/buy|\/spc\/|go-to-checkout|\/turbo|\/gp\/cart\/desktop\/go-to-checkout|place-?order/i;

/** Keep-alive: refresh tokens before use if the account sat idle this long. */
const KEEPALIVE_MS = 12 * 60 * 60 * 1000;

const PLACE_ORDER_PATH = /^\/checkout\/p\/[\w-]+\/spc\/place-order$/;

/** Narrow exceptions to the purchase guard (see RequestOptions.checkout). */
export function checkoutAllowed(url: string, opts: Pick<RequestOptions, "checkout" | "method">): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (opts.checkout === "read") {
    return (opts.method ?? "GET") === "GET" && (path.startsWith("/checkout/") || path.startsWith("/gp/buy/thankyou")) && !/place-?order/i.test(path);
  }
  if (opts.checkout === "place") return opts.method === "POST" && PLACE_ORDER_PATH.test(path);
  return false;
}

export class BlockedError extends Error {
  constructor(public url: string, public status: number, signedIn: boolean) {
    super(
      signedIn
        ? `Amazon asked for a security check (${status}). Call amazon_signin and send the user the link — they solve the check there.`
        : `Amazon blocked or challenged this request (${status}). Stopped without retrying. Wait before trying again, and stop using Basketly if Amazon keeps blocking it.`,
    );
    this.name = "BlockedError";
  }
}

export class SignInRequiredError extends Error {
  constructor() {
    super("The Amazon sign-in has expired. Call amazon_signin (via \"link\" unless the user is at this computer) and send the user the link to sign in again.");
    this.name = "SignInRequiredError";
  }
}

export class PurchaseBlockedError extends Error {
  constructor(url: string) {
    super(`Refused: ${url} is a checkout/purchase URL. This client never buys.`);
    this.name = "PurchaseBlockedError";
  }
}

export interface SessionOptions {
  marketplace?: keyof typeof MARKETPLACES;
  /** Persist cookies + cart ledger + account info here. Defaults to ~/.amazon-agent/session.json. */
  sessionFile?: string | null;
  /** Minimum gap between requests, ms. */
  minIntervalMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Skip block/sign-out detection and renewal (used by renewal itself). */
  raw?: boolean;
  /**
   * The only ways past the purchase guard:
   *  "read"  — GET Amazon's order page to show the user what an order would be (never places it);
   *  "place" — the single POST to …/spc/place-order, made only by AmazonClient.placeOrder after
   *            the user pressed Place order in the order card.
   */
  checkout?: "read" | "place";
}

export interface LedgerItem {
  asin: string;
  quantity: number;
}

export interface WatchItem {
  asin: string;
  title: string;
  /** Alert when the price is at or below this (marketplace currency). */
  below: number;
  lastPrice: number | null;
  lowestPrice: number | null;
  checkedAt: string | null;
  url: string;
  image: string | null;
}

export interface AccountInfo {
  name: string | null;
  signedInAt: string;
}

export class Session {
  readonly mp: Marketplace;
  private cookies = new Map<string, string>();
  /** Last known cart contents; used to rebuild a guest cart after renewal and to replay it after sign-in. */
  private ledger: LedgerItem[] = [];
  private accountInfo: AccountInfo | null = null;
  private ua = DEFAULT_UA;
  private lastUsed = 0;
  private termsAt: string | null = null;
  private watches: WatchItem[] = [];
  /** Called after every renewal that should keep the cart (see renew). */
  onRenew?: (ledger: LedgerItem[]) => Promise<void>;
  private restoring = false;
  private last = 0;
  readonly file: string | null;
  private readonly gap: number;

  constructor(opts: SessionOptions = {}) {
    this.mp = MARKETPLACES[opts.marketplace ?? "us"]!;
    this.file = opts.sessionFile === undefined ? DEFAULT_SESSION_FILE : opts.sessionFile;
    this.gap = opts.minIntervalMs ?? 1500;
    if (this.file && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8"));
        // v1 files were a flat cookie map; v2+ is { cookies, cart, account, ua, lastUsed }.
        const cookies = data.cookies && typeof data.cookies === "object" ? data.cookies : data;
        for (const [k, v] of Object.entries(cookies)) if (typeof v === "string") this.cookies.set(k, v);
        if (Array.isArray(data.cart)) this.ledger = data.cart;
        if (data.account) this.accountInfo = data.account;
        if (typeof data.ua === "string") this.ua = data.ua;
        if (typeof data.lastUsed === "number") this.lastUsed = data.lastUsed;
        if (typeof data.termsAcceptedAt === "string") this.termsAt = data.termsAcceptedAt;
        if (Array.isArray(data.watch)) this.watches = data.watch;
      } catch {
        /* corrupt file → start fresh */
      }
    }
  }

  get base() {
    return `https://${this.mp.host}`;
  }

  get hasSession() {
    return this.cookies.has("session-id");
  }

  get signedIn() {
    return ACCOUNT_COOKIES.some((c) => this.cookies.has(c));
  }

  get mode(): "account" | "guest" {
    return this.signedIn ? "account" : "guest";
  }

  get account(): AccountInfo | null {
    return this.signedIn ? this.accountInfo : null;
  }

  get lastUsedAt(): Date | null {
    return this.lastUsed ? new Date(this.lastUsed) : null;
  }

  get cart(): readonly LedgerItem[] {
    return this.ledger;
  }

  setCart(items: LedgerItem[]) {
    this.ledger = items.map(({ asin, quantity }) => ({ asin, quantity }));
    this.save();
  }

  /** Replace the jar with a signed-in browser's cookies (from signin.ts). Keeps the ledger. */
  adoptAccount(cookies: Record<string, string>, info: AccountInfo, userAgent?: string) {
    this.cookies = new Map(Object.entries(cookies));
    this.accountInfo = info;
    if (userAgent) this.ua = userAgent;
    this.lastUsed = Date.now();
    this.save();
  }

  /** When the user accepted the ordering terms (TERMS.md), or null. */
  get termsAcceptedAt(): string | null {
    return this.termsAt;
  }

  get watchlist(): readonly WatchItem[] {
    return this.watches;
  }

  setWatchlist(items: WatchItem[]) {
    this.watches = items;
    this.save();
  }

  acceptTerms() {
    this.termsAt = new Date().toISOString();
    this.save();
  }

  /** Forget the account: cookies, account info and ledger. */
  signOut() {
    this.cookies.clear();
    this.accountInfo = null;
    this.ledger = [];
    this.ua = DEFAULT_UA;
    this.save();
  }

  /**
   * Guest mode only: drop all cookies and get a fresh anonymous session.
   * Amazon ties a guest cart to its session, so by default the ledger is
   * replayed into the new cart via onRenew. Pass keepCart:false to start empty.
   */
  async renew({ keepCart = true }: { keepCart?: boolean } = {}): Promise<void> {
    this.cookies.clear();
    this.accountInfo = null;
    if (!keepCart) this.ledger = [];
    await this.request(`${this.base}/`, { raw: true });
    this.save();
    if (keepCart && this.ledger.length && this.onRenew && !this.restoring) {
      this.restoring = true;
      try {
        await this.onRenew([...this.ledger]);
      } finally {
        this.restoring = false;
      }
    }
  }

  /** Make sure there is a usable session: create a guest one, or refresh an idle account. */
  async ensure(): Promise<void> {
    if (!this.hasSession && !this.signedIn) return this.renew();
    if (this.signedIn && Date.now() - this.lastUsed > KEEPALIVE_MS) {
      // Touch the home page so Amazon rotates the account tokens; Set-Cookie is absorbed.
      await this.request(`${this.base}/`);
    }
  }

  async text(url: string, opts: RequestOptions = {}): Promise<{ status: number; url: string; body: string }> {
    const res = await this.request(url, opts);
    return { status: res.status, url: res.url, body: await res.text() };
  }

  /**
   * Request with cookies + throttle.
   * A block (captcha / 503) always throws immediately without renewing or retrying.
   */
  async request(url: string, opts: RequestOptions = {}): Promise<Response> {
    if (PURCHASE_URL.test(url) && !checkoutAllowed(url, opts)) throw new PurchaseBlockedError(url);
    const wait = this.last + this.gap - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    this.last = Date.now();

    let current = url;
    let method = opts.method ?? "GET";
    let body = opts.body;
    let res: Response;
    // Follow redirects manually so Set-Cookie on every hop lands in the jar.
    for (let hop = 0; ; hop++) {
      res = await fetch(current, {
        method,
        body,
        redirect: "manual",
        headers: {
          "User-Agent": withAgentTag(this.ua),
          "Accept-Language": this.mp.lang,
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
          ...opts.headers,
        },
      });
      this.absorb(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc && hop < 8) {
        current = new URL(loc, current).toString();
        // After the one place-order POST, Amazon redirects to its confirmation page: a read.
        const hopMode = opts.checkout === "place" ? "read" : opts.checkout;
        if (PURCHASE_URL.test(current) && !checkoutAllowed(current, { checkout: hopMode, method: res.status === 307 || res.status === 308 ? method : "GET" })) {
          throw new PurchaseBlockedError(current);
        }
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      break;
    }
    const wasSignedIn = this.signedIn;
    if (current.startsWith(this.base)) this.lastUsed = Date.now();
    this.save();

    if (opts.raw) return res;
    const head = await peekHtml(res);
    const blocked = res.status === 503 || current.includes("/errors/validateCaptcha") || isCaptcha(head);
    if (blocked) throw new BlockedError(url, res.status, wasSignedIn);
    if (wasSignedIn && (current.includes("/ap/signin") || isSignedOutPage(head))) throw new SignInRequiredError();
    return res;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i < 1) continue;
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (!v || v === '""' || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify(
        { cookies: Object.fromEntries(this.cookies), cart: this.ledger, account: this.accountInfo, ua: this.ua, lastUsed: this.lastUsed, termsAcceptedAt: this.termsAt, watch: this.watches },
        null,
        1,
      ),
      { mode: 0o600 },
    );
    chmodSync(this.file, 0o600); // writeFileSync's mode only applies on create
  }
}

/** First 300 KB of an HTML body (the nav greeting sits ~110–130 KB in), without consuming the response. */
async function peekHtml(res: Response): Promise<string> {
  if (!(res.headers.get("content-type") ?? "").includes("html")) return "";
  return (await res.clone().text()).slice(0, 300_000);
}

export function isCaptcha(head: string): boolean {
  return (
    head.includes("/errors/validateCaptcha") ||
    head.includes("Type the characters you see in this image") ||
    // Newer JS "interstitial" challenge served instead of the page (seen Nov 2026). Never solved — reported.
    head.includes("triggerInterstitialChallenge")
  );
}

/** The nav greeting reads "Hello, sign in" only for signed-out visitors. */
export function isSignedOutPage(head: string): boolean {
  return /nav-link-accountList-nav-line-1"[^>]*>\s*Hello, sign in/i.test(head);
}

/** Download a product image for an MCP image block. Images are public; no cookies are sent. */
export async function fetchImage(url: string, maxSide = 500): Promise<{ data: string; mimeType: string } | null> {
  try {
    // Amazon image URLs take a size modifier: /images/I/<id>[.<mods>].jpg → /images/I/<id>._AC_SL500_.jpg
    const sized = url.replace(/(\/images\/I\/[^./]+)(?:\.[^/]*)?\.(jpe?g|png|webp)$/i, `$1._AC_SL${maxSide}_.$2`);
    const res = await fetch(sized, { headers: { "User-Agent": withAgentTag(DEFAULT_UA) } });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!;
    if (!mimeType.startsWith("image/")) return null;
    return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
  } catch {
    return null;
  }
}
