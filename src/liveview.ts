// One-time live view of the headless sign-in browser.
// The user sees Amazon's real sign-in page (CDP screencast frames over a WebSocket) and drives it
// with taps and typing. Nothing here reads the page's form fields — input only flows *into* the
// browser, and the only thing taken out is the account cookies (in signin.ts).
//
// Phones: the remote browser emulates the viewer's device (width, pixel density, touch, mobile UA)
// so Amazon serves its mobile sign-in page at native sharpness.
//
// Security: 256-bit token in the path, constant-time compared; first device to open the link
// locks it with an HttpOnly cookie; link expires; one live socket; strict headers; 127.0.0.1 only.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CDPSession, Page } from "playwright";
import { withAgentTag } from "./http.ts";

export interface LiveViewOptions {
  page: Page;
  cdp: CDPSession;
  token: string;
  expiresAt: Date;
  /** Desktop UA of the sign-in browser; the mobile UA is derived from its Chrome version. */
  desktopUa: string;
  /** 0 = random free port. */
  port?: number;
}

export interface LiveView {
  port: number;
  /** Show the success screen, then stop accepting input. */
  finish(name: string | null): void;
  close(): void;
}

export type ClientMsg =
  | { t: "viewport"; w: number; h: number; dpr: number; mobile: boolean }
  | { t: "tap"; x: number; y: number }
  | { t: "scroll"; dy: number }
  | { t: "text"; text: string }
  | { t: "key"; key: string }
  | { t: "back" };

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const LOCK_COOKIE = "lv";

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Validate a client message; anything malformed is dropped. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  const n = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  switch (m.t) {
    case "viewport":
      return n(m.w, 280, 1600) && n(m.h, 300, 2000) && n(m.dpr, 1, 4) && typeof m.mobile === "boolean"
        ? { t: "viewport", w: Math.round(m.w as number), h: Math.round(m.h as number), dpr: m.dpr as number, mobile: m.mobile }
        : null;
    case "tap":
      return n(m.x, 0, 1600) && n(m.y, 0, 2000) ? { t: "tap", x: m.x as number, y: m.y as number } : null;
    case "scroll":
      return n(m.dy, -3000, 3000) ? { t: "scroll", dy: m.dy as number } : null;
    case "text":
      return typeof m.text === "string" && m.text.length > 0 && m.text.length <= 512 ? { t: "text", text: m.text } : null;
    case "key":
      return typeof m.key === "string" && KEYS.has(m.key) ? { t: "key", key: m.key } : null;
    case "back":
      return { t: "back" };
    default:
      return null;
  }
}

/** Chrome-on-Android UA + client hints matching the desktop Chrome version. */
export function mobileIdentity(desktopUa: string) {
  const full = desktopUa.match(/Chrome\/([\d.]+)/)?.[1] ?? "130.0.0.0";
  const major = full.split(".")[0]!;
  return {
    userAgent: withAgentTag(`Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`),
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Not?A_Brand", version: "99" },
      ],
      fullVersion: full,
      platform: "Android",
      platformVersion: "10.0.0",
      architecture: "",
      model: "K",
      mobile: true,
    },
  };
}

export function startLiveView({ page, cdp, token, expiresAt, desktopUa, port = 0 }: LiveViewOptions): LiveView {
  const base = `/s/${token}`;
  // The lock is taken by the first *live connection*, not the first page load: chat apps and
  // messengers fetch links to build previews, and those must not lock the user out. Every page
  // load gets its own visitor id; the first id to open the WebSocket (only a real browser running
  // the viewer's script does) becomes the lock holder.
  let lockId: string | null = null;
  const issued = new Set<string>(); // visitor ids handed out before the lock was taken
  const MAX_ISSUED = 50;
  let socket: Bun.ServerWebSocket<unknown> | null = null;
  let finished: { name: string | null } | null = null;
  let streaming = false;
  let device = { w: 1000, h: 800, dpr: 1, mobile: false };

  const expired = () => Date.now() > expiresAt.getTime();
  const cookieOf = (req: Request) =>
    (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${LOCK_COOKIE}=`))?.slice(LOCK_COOKIE.length + 1) ?? "";
  const isLockHolder = (req: Request) => lockId !== null && sameToken(cookieOf(req), lockId);
  const isIssued = (req: Request) => {
    const id = cookieOf(req);
    return id !== "" && [...issued].some((v) => sameToken(v, id));
  };
  const tokenOf = (path: string) => path.match(/^\/s\/([A-Za-z0-9_-]{43})(\/ws)?$/);

  const headers = (extra: Record<string, string> = {}) => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  const text = (status: number, body: string) => new Response(body, { status, headers: headers({ "Content-Type": "text/plain; charset=utf-8" }) });

  // Screencast frames are always at CSS-pixel size (blurry on 2–3× phones), so they only signal
  // "the page changed". Each change triggers a full-resolution screenshot at the device's pixel
  // density, coalesced so a busy page can't flood the connection. Sent as binary JPEG.
  let dirty = false;
  let capturing = false;
  async function pump() {
    if (capturing) return;
    capturing = true;
    try {
      while (dirty && socket && streaming) {
        dirty = false;
        const shot = await cdp
          .send("Page.captureScreenshot", { format: "jpeg", quality: 82, optimizeForSpeed: true })
          .catch(() => null);
        if (shot?.data && socket) socket.sendBinary(Buffer.from(shot.data, "base64"));
        await Bun.sleep(80); // ≤ ~12 fps
      }
    } finally {
      capturing = false;
    }
  }
  cdp.on("Page.screencastFrame", ({ sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    dirty = true;
    void pump();
  });

  async function startStream() {
    if (streaming) await cdp.send("Page.stopScreencast").catch(() => {});
    streaming = true;
    // Tiny low-quality frames: we only use them as change notifications.
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 200, maxHeight: 200, everyNthFrame: 1 }).catch(() => {});
    dirty = true;
    void pump();
  }
  async function stopStream() {
    if (!streaming) return;
    streaming = false;
    await cdp.send("Page.stopScreencast").catch(() => {});
  }

  /** Make the remote browser look like the viewer's device; reload if desktop ↔ mobile changed. */
  async function emulate(next: typeof device) {
    const switched = next.mobile !== device.mobile;
    device = next;
    const dpr = Math.min(device.dpr, 3);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: device.w, height: device.h, deviceScaleFactor: dpr, mobile: device.mobile });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: device.mobile, maxTouchPoints: device.mobile ? 5 : 1 });
    await cdp.send(
      "Emulation.setUserAgentOverride",
      device.mobile ? mobileIdentity(desktopUa) : { userAgent: withAgentTag(desktopUa) },
    );
    if (switched) await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    if (socket) await startStream();
  }

  async function tap(x: number, y: number) {
    if (!device.mobile) return page.mouse.click(x, y);
    const point = [{ x, y }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /**
   * What kind of field has focus in the remote page — read from its attributes only (type, name,
   * autocomplete), never its value — so the viewer can switch its own input and let the phone's
   * password manager offer the user's saved Amazon login.
   */
  async function reportFocus() {
    // Runs in the page (string form: this file isn't compiled with DOM types).
    const kind = await page
      .evaluate<string>(`(() => {
        const e = document.activeElement;
        if (!(e instanceof HTMLInputElement)) return "none";
        const hint = (e.name + " " + e.id + " " + e.autocomplete).toLowerCase();
        if (e.type === "password") return "password";
        if (e.autocomplete === "one-time-code" || /otp|code|cvf/.test(hint)) return "otp";
        if (e.type === "email" || /email|user|claim|login/.test(hint)) return "username";
        return "text";
      })()`)
      .catch(() => "none");
    socket?.send(JSON.stringify({ t: "focus", kind }));
  }

  async function handle(msg: ClientMsg) {
    if (finished) return;
    switch (msg.t) {
      case "viewport":
        await emulate({ w: msg.w, h: msg.h, dpr: msg.dpr, mobile: msg.mobile });
        break;
      case "tap":
        await tap(msg.x, msg.y);
        await Bun.sleep(60);
        await reportFocus();
        break;
      case "scroll":
        await page.mouse.move(device.w / 2, device.h / 2);
        await page.mouse.wheel(0, msg.dy);
        break;
      case "text":
        await page.keyboard.insertText(msg.text);
        break;
      case "back":
        // Stays inside Amazon: the route allowlist still applies to history navigation.
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
      case "key":
        await page.keyboard.press(msg.key);
        if (msg.key === "Tab" || msg.key === "Enter") {
          await Bun.sleep(msg.key === "Enter" ? 800 : 60); // Enter may load the next sign-in step
          await reportFocus();
        }
        break;
    }
  }

  // Input is applied strictly in order (typing must not reorder).
  let queue: Promise<unknown> = Promise.resolve();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") return text(200, "ok");
      const m = tokenOf(url.pathname);
      if (!m || !sameToken(m[1]!, token)) return text(404, "Not found");
      if (expired()) return text(410, "This sign-in link has expired. Ask the agent for a new one.");
      const https = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https" || url.hostname !== "127.0.0.1";

      if (m[2]) {
        // WebSocket: the first visitor to connect takes the lock; after that only the holder.
        if (lockId === null) {
          const id = cookieOf(req);
          const known = [...issued].find((v) => sameToken(v, id));
          if (!known) return text(403, "Open the link first.");
          lockId = known;
          issued.clear();
        } else if (!isLockHolder(req)) {
          return text(403, "This link is already open on another device.");
        }
        return srv.upgrade(req) ? undefined : text(400, "Expected a WebSocket");
      }

      // Page: anyone with the link may load it until a device connects (previews included);
      // once locked, only the lock holder.
      let setCookie: string | undefined;
      if (lockId === null) {
        if (!isIssued(req)) {
          if (issued.size >= MAX_ISSUED) return text(429, "Too many visits to this link. Ask the agent for a new one.");
          const id = randomBytes(24).toString("base64url");
          issued.add(id);
          setCookie = `${LOCK_COOKIE}=${id}; Path=${base}; HttpOnly; SameSite=Strict${https ? "; Secure" : ""}; Max-Age=900`;
        }
      } else if (!isLockHolder(req)) {
        return text(403, "This link is already open on another device.");
      }
      const nonce = randomBytes(16).toString("base64");
      const wsOrigin = `${https ? "wss" : "ws"}://${req.headers.get("x-forwarded-host") ?? url.host}`;
      return new Response(viewerHtml(nonce, expiresAt), {
        headers: headers({
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src ${wsOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          ...(setCookie ? { "Set-Cookie": setCookie } : {}),
        }),
      });
    },
    websocket: {
      async open(ws) {
        socket?.close(4000, "Replaced by a newer connection");
        socket = ws;
        if (finished) ws.send(JSON.stringify({ t: "done", name: finished.name }));
        else await startStream();
      },
      message(ws, raw) {
        if (ws !== socket || expired()) return;
        const msg = parseClientMsg(typeof raw === "string" ? raw : Buffer.from(raw).toString());
        if (msg) queue = queue.then(() => handle(msg)).catch(() => {});
      },
      async close(ws) {
        if (ws === socket) {
          socket = null;
          await stopStream();
        }
      },
    },
  });

  return {
    port: server.port!,
    finish(name) {
      finished = { name };
      socket?.send(JSON.stringify({ t: "done", name }));
      void stopStream();
    },
    close() {
      void stopStream();
      socket?.close(1000, "Closed");
      server.stop(true);
    },
  };
}

/** The viewer page. All script/style is nonce'd; frames arrive as blob: images; no external resources. */
function viewerHtml(nonce: string, expiresAt: Date): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Amazon sign-in for your agent</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#f6f6f4; --fg:#1d1d1b; --muted:#6b6b66; --line:#d9d9d4; --accent:#e47911; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ececea; --muted:#9a9a95; --line:#33332f; } }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overscroll-behavior:none; }
  body { display:flex; flex-direction:column; height:100dvh; }
  header { padding:8px 12px; padding-top:max(8px, env(safe-area-inset-top)); display:flex; gap:8px; align-items:center; border-bottom:1px solid var(--line); }
  header b { font-weight:600; }
  header span { color:var(--muted); font-size:12px; margin-left:auto; white-space:nowrap; font-variant-numeric: tabular-nums; }
  header button { font:inherit; font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; background:transparent; color:var(--fg); }
  #stage { flex:1; position:relative; overflow:hidden; background:#fff; touch-action:none; }
  #screen { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; object-position:top center; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
  #msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; color:#fff; background:rgba(20,20,19,.72); font-size:16px; line-height:1.5; }
  #msg[hidden] { display:none; }
  /* Off-screen but focusable: it receives the phone keyboard's input, which is forwarded live. */
  #kbd { position:fixed; left:0; bottom:0; width:1px; height:1px; opacity:0; font-size:16px; border:0; padding:0; }
  /* Visible field for email / password / code steps: iOS only offers saved passwords and the
     native paste menu on a real, visible input inside a form. */
  #cred { display:flex; gap:8px; align-items:center; padding:10px 12px; padding-bottom:max(10px, env(safe-area-inset-bottom)); border-top:1px solid var(--line); background:var(--bg); }
  #cred[hidden] { display:none; }
  #cred input { flex:1; min-width:0; font-size:17px; padding:12px; border:2px solid var(--accent); border-radius:10px; background:#fff; color:#111; }
  #cred button { font:inherit; font-size:15px; font-weight:600; padding:12px 14px; border:0; border-radius:10px; background:var(--accent); color:#fff; }
</style></head>
<body>
<header><button id="back" type="button" aria-label="Back">←</button><b>🔐 Amazon</b><button id="kb" type="button">⌨️</button><span id="timer"></span></header>
<div id="stage"><img id="screen" alt="Amazon sign-in page" draggable="false"><div id="msg">Connecting…</div></div>
<form id="cred" hidden autocomplete="on"><input id="field" name="field" autocapitalize="off" autocorrect="off" spellcheck="false"><button id="go" type="submit">Continue</button></form>
<input id="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Type into the page">
<script nonce="${nonce}">
(() => {
  const exp = ${expiresAt.getTime()};
  const $ = (id) => document.getElementById(id);
  const img = $("screen"), msg = $("msg"), stage = $("stage"), kbd = $("kbd"), timer = $("timer");
  const cred = $("cred"), field = $("field");
  const mobile = matchMedia("(pointer: coarse)").matches;
  let ws, done = false, lastUrl = null, view = { w: 1, h: 1 };
  const show = (t) => { msg.textContent = t; msg.hidden = !t; };
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

  const tick = () => {
    const s = Math.max(0, Math.round((exp - Date.now()) / 1000));
    timer.textContent = done ? "" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    if (!done && s === 0) { show("This link has expired. Ask your agent for a new one."); ws && ws.close(); }
  };
  setInterval(tick, 1000); tick();

  // The remote page is rendered at exactly this size and pixel density, so frames map 1:1.
  function viewport() {
    const r = stage.getBoundingClientRect();
    view = { w: Math.round(r.width), h: Math.round(r.height) };
    send({ t: "viewport", w: Math.max(320, Math.min(1200, view.w)), h: Math.max(400, Math.min(1600, view.h)), dpr: Math.min(3, Math.max(1, devicePixelRatio || 1)), mobile });
  }

  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname + "/ws");
    ws.binaryType = "blob";
    ws.onopen = () => { show("Loading Amazon…"); viewport(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const url = URL.createObjectURL(e.data);
        img.onload = () => { if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; };
        img.src = url;
        if (!done) show("");
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === "focus") { setKind(m.kind); return; }
      if (m.t === "done") { done = true; tick(); kbd.blur(); field.blur(); cred.hidden = true; show("✅ Signed in" + (m.name ? " as " + m.name : "") + ".\\nYou can close this page — your agent can use your Amazon cart now."); }
    };
    ws.onclose = (e) => { if (!done && Date.now() < exp) show(e.code === 4000 ? "Opened in another tab." : "Disconnected — reload to reconnect."); };
  }

  // Taps / clicks → page coordinates (image is drawn at stage size, top-aligned).
  function point(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    return { x: Math.max(0, clientX - r.left), y: Math.max(0, clientY - r.top) };
  }
  let start = null, moved = false;
  stage.addEventListener("pointerdown", (e) => { start = { x: e.clientX, y: e.clientY }; moved = false; });
  stage.addEventListener("pointermove", (e) => {
    if (!start || e.pointerType === "mouse") return;
    const dy = start.y - e.clientY;
    if (Math.abs(dy) > 6) { moved = true; send({ t: "scroll", dy: dy * 1.5 }); start = { x: e.clientX, y: e.clientY }; }
  });
  stage.addEventListener("pointerup", (e) => {
    if (start && !moved) { send({ t: "tap", ...point(e.clientX, e.clientY) }); focusKeyboard(); } // server replies with the field kind
    start = null;
  });
  stage.addEventListener("wheel", (e) => { e.preventDefault(); send({ t: "scroll", dy: e.deltaY }); }, { passive: false });

  // Email, password and code steps get a real, visible field (inside a form) so the phone offers
  // its saved logins / one-time codes and the native paste menu. Its value is sent in one go on
  // Continue, followed by Enter — like submitting a normal login form. Other fields use live typing.
  const CRED = {
    username: { type: "email", autocomplete: "username", inputmode: "email", placeholder: "Email or mobile number" },
    password: { type: "password", autocomplete: "current-password", inputmode: "text", placeholder: "Password — or tap 🔑 for a saved one" },
    otp: { type: "text", autocomplete: "one-time-code", inputmode: "numeric", placeholder: "Code" },
  };
  function setKind(kind) {
    const c = CRED[kind];
    if (!c) { cred.hidden = true; if (kind === "none") kbd.blur(); return; }
    kbd.blur();
    field.type = c.type; field.autocomplete = c.autocomplete; field.inputMode = c.inputmode; field.placeholder = c.placeholder;
    field.value = "";
    cred.hidden = false;
    field.focus(); // phones may need a tap on the field to open the keyboard (focus outside a gesture)
  }
  cred.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = field.value;
    if (v) send({ t: "text", text: v.slice(0, 512) });
    send({ t: "key", key: "Enter" });
    field.value = "";
    cred.hidden = true;
    field.blur();
  });

  // Live typing: the hidden input always holds one space; any change is forwarded and reset.
  const SENTINEL = " ";
  function focusKeyboard() {
    kbd.value = SENTINEL; kbd.focus({ preventScroll: true });
    try { kbd.setSelectionRange(1, 1); } catch {} // email inputs don't support selection ranges
  }
  $("kb").addEventListener("click", focusKeyboard);
  $("back").addEventListener("click", () => send({ t: "back" }));
  kbd.addEventListener("input", () => {
    const v = kbd.value;
    if (v.length < SENTINEL.length) send({ t: "key", key: "Backspace" });
    else if (v.startsWith(SENTINEL) && v.length > 1) send({ t: "text", text: v.slice(1) });
    else if (v && v !== SENTINEL) send({ t: "text", text: v });
    kbd.value = SENTINEL;
    try { kbd.setSelectionRange(1, 1); } catch {}
  });
  kbd.addEventListener("keydown", (e) => {
    const special = { Enter: "Enter", Tab: "Tab", Escape: "Escape", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown" }[e.key];
    if (special) { e.preventDefault(); send({ t: "key", key: special }); }
    else if (e.key === "Backspace" && (kbd.value === SENTINEL || kbd.value === "")) { e.preventDefault(); send({ t: "key", key: "Backspace" }); }
  });

  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(viewport, 250); });
  connect();
})();
</script>
</body></html>`;
}
