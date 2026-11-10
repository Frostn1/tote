// Shared HTML parsers. They rely on Amazon's most stable hooks (data-* attributes, ids).
import { parse, type HTMLElement } from "node-html-parser";

export interface SearchResult {
  asin: string;
  title: string;
  price: number | null;
  priceText: string | null;
  listPrice: string | null;
  rating: number | null;
  reviews: number | null;
  image: string | null;
  url: string;
  sponsored: boolean;
}

export interface Refinement {
  group: string;
  label: string;
  /** Pass to search({ filters }) — combine several with commas. */
  rh: string;
}

const GROUP_NAMES: Record<string, string> = { p_36: "Price", p_72: "Customer Review", p_76: "Prime / Free Shipping", p_89: "Brand", p_123: "Brands", n: "Department" };

/** A live "Next" button (Amazon marks the last page with s-pagination-disabled). */
const hasNextPage = (html: string) => /aria-label=\\?"Go to next page/.test(html);

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

/** The text a shopper sees: Amazon nests <script> blocks (page code, a-state JSON) inside some widgets. */
function visibleText(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  const copy = parse(el.outerHTML);
  for (const junk of copy.querySelectorAll("script, style, noscript, template, form")) junk.remove();
  return clean(copy.text);
}

/** Buyable only with a real offer and a visible Add to Cart button; unavailable pages keep an empty form. */
function hasOffer(doc: HTMLElement): boolean {
  const offer = doc.querySelector("form#addToCart input[name=offerListingID]")?.getAttribute("value")?.trim();
  return !!offer && !!doc.querySelector("#add-to-cart-button");
}

export function money(s: string | undefined | null): number | null {
  const m = clean(s).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function num(s: string | undefined | null): number | null {
  const m = clean(s).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Pull an ASIN out of a bare ASIN or any Amazon product URL (/dp/, /gp/product/, /gp/aw/d/). */
export function asinFrom(input: string): string {
  const s = input.trim();
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?=[/?#]|$)/i);
  if (!m) throw new Error(`No ASIN found in "${input}"`);
  return m[1]!.toUpperCase();
}

export function parseCard(el: HTMLElement, base: string): SearchResult | null {
  const asin = el.getAttribute("data-asin");
  if (!asin) return null;
  const h2 = el.querySelector("h2");
  const title = clean(h2?.text) || clean(h2?.getAttribute("aria-label")).replace(/^Sponsored Ad - /, "");
  if (!title) return null;
  const priceText = clean(el.querySelector(".a-price:not(.a-text-price) .a-offscreen")?.text) || null;
  return {
    asin,
    title,
    price: money(priceText),
    priceText,
    listPrice: clean(el.querySelector(".a-price.a-text-price[data-a-strike=true] .a-offscreen")?.text) || null,
    rating: num(el.querySelector(".a-icon-alt")?.text),
    reviews: num(el.querySelector("[aria-label$=ratings]")?.getAttribute("aria-label")),
    image: el.querySelector("img.s-image")?.getAttribute("src") ?? null,
    url: `${base}/dp/${asin}`,
    sponsored:
      el.classList.contains("AdHolder") ||
      /^Sponsored/.test(clean(h2?.getAttribute("aria-label"))) ||
      !!el.querySelector(".puis-sponsored-label-text"),
  };
}

export function parseSearchPage(html: string, base: string) {
  const doc = parse(html);
  const results = dedupe(
    doc
      .querySelectorAll("div[data-component-type=s-search-result]")
      .map((el) => parseCard(el, base))
      .filter((r): r is SearchResult => !!r),
  );
  const info = clean(doc.querySelector("[data-component-type=s-result-info-bar] h2, [data-component-type=s-result-info-bar]")?.text);
  const total = num(info.match(/(?:of|over)\s+(?:over\s+)?([\d,]+)\s+results/)?.[1] ?? info.match(/([\d,]+)\s+results/)?.[1]);
  const hasNext = hasNextPage(html);
  // An empty result list is only real when Amazon says so; otherwise the page wasn't a results page.
  const emptyByAmazon = /No results for|did not match any products|We couldn.t find a match/i.test(clean(doc.text));
  return { results, total, hasNext, refinements: parseRefinements(doc), unexpected: !results.length && !emptyByAmazon };
}

export function parseRefinements(doc: HTMLElement): Refinement[] {
  const out: Refinement[] = [];
  const seen = new Set<string>();
  for (const li of doc.querySelectorAll("#s-refinements li[id]")) {
    const id = li.getAttribute("id")!; // e.g. "p_123/486782"
    const slash = id.indexOf("/");
    if (slash < 1) continue;
    const key = id.slice(0, slash);
    const value = id.slice(slash + 1);
    if (value.startsWith("dynamic")) continue; // price slider placeholders — use minPrice/maxPrice instead
    const rh = `${key}:${value}`;
    if (seen.has(rh)) continue;
    seen.add(rh);
    const a = li.querySelector("a");
    const label =
      clean(a?.getAttribute("aria-label")?.match(/^(?:Apply|Remove) (?:the filter )?(.*?) filter/)?.[1]) ||
      clean(li.querySelector(".a-size-base, .a-color-base")?.text) ||
      clean(li.text);
    const group = clean(doc.querySelector(`[id="${key}-title"]`)?.text) || GROUP_NAMES[key] || key;
    out.push({ group, label, rh });
  }
  return out;
}

/** Split the /s/query "&&&"-delimited stream into result cards. */
export function parseSearchStream(body: string, base: string) {
  const results: SearchResult[] = [];
  const hasNext = hasNextPage(body);
  for (const chunk of body.split("&&&")) {
    const t = chunk.trim();
    if (!t) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if (!Array.isArray(msg)) continue;
    const payload = msg[2] as { asin?: string; html?: string } | undefined;
    if (!payload?.asin || !payload.html) continue;
    const el = parse(payload.html).querySelector("[data-asin]");
    if (el?.getAttribute("data-component-type") !== "s-search-result") continue;
    const card = parseCard(el, base);
    if (card) results.push(card);
  }
  return { results: dedupe(results), hasNext };
}

function dedupe(rs: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const k = `${r.asin}:${r.sponsored}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Product {
  asin: string;
  title: string;
  brand: string | null;
  price: number | null;
  priceText: string | null;
  rating: number | null;
  reviews: number | null;
  availability: string | null;
  bullets: string[];
  images: string[];
  url: string;
  /** False when there is no buy box (unavailable / see all buying options). */
  canAddToCart: boolean;
  /** Size / colour / … options, when the listing has them. */
  variants?: Variants | null;
}

export function parseProduct(html: string, asin: string, base: string): Product {
  const doc = parse(html);
  // First place that actually holds a price (pages carry empty placeholders in some of these).
  const priceSelectors = [
    "#corePrice_feature_div .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#apex_offerDisplay_desktop .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "#price_inside_buybox",
    ".priceToPay .a-offscreen",
  ];
  let priceText: string | null = null;
  for (const sel of priceSelectors) {
    const hit = doc.querySelectorAll(sel).map((e) => clean(e.text)).find((t) => /\$\s?\d/.test(t));
    if (hit) {
      priceText = hit;
      break;
    }
  }
  if (!priceText) {
    const v = doc.querySelector("#twister-plus-price-data-price")?.getAttribute("value") ?? html.match(/"priceAmount"\s*:\s*([\d.]+)/)?.[1];
    if (v && Number(v) > 0) priceText = `$${Number(v).toFixed(2)}`;
  }
  let images: string[] = [];
  const dyn = doc.querySelector("#landingImage, #imgBlkFront")?.getAttribute("data-a-dynamic-image");
  if (dyn) {
    try {
      images = Object.keys(JSON.parse(dyn.replace(/&quot;/g, '"')));
    } catch {
      /* ignore */
    }
  }
  const hiRes = [...html.matchAll(/"hiRes":"(https:[^"]+)"/g)].map((m) => m[1]!);
  if (hiRes.length) images = [...new Set(hiRes)];
  return {
    asin,
    title: clean(doc.querySelector("#productTitle")?.text),
    brand: clean(doc.querySelector("#bylineInfo")?.text).replace(/^(Visit the|Brand:)\s*/i, "").replace(/\s*Store$/, "") || null,
    price: money(priceText),
    priceText,
    rating: num(doc.querySelector("#acrPopover")?.getAttribute("title")),
    reviews: num(doc.querySelector("#acrCustomerReviewText")?.text),
    availability: visibleText(doc.querySelector("#availability")) || null,
    bullets: doc.querySelectorAll("#feature-bullets li span.a-list-item").map((e) => clean(e.text)).filter(Boolean),
    images,
    url: `${base}/dp/${asin}`,
    canAddToCart: hasOffer(doc),
    variants: parseVariants(html),
  };
}

/** The buy-box form fields that /cart/add-to-cart needs (incl. CSRF + offer listing id). */
export function buyBoxForm(html: string): URLSearchParams | null {
  const doc = parse(html);
  const form = doc.querySelector("form#addToCart");
  if (!form || !hasOffer(doc)) return null;
  const fd = new URLSearchParams();
  for (const i of form.querySelectorAll("input")) {
    const n = i.getAttribute("name");
    if (!n || n === "submit.buy-now" || n === "isBuyNow") continue; // never trigger buy-now
    fd.append(n, i.getAttribute("value") ?? "");
  }
  return fd.get("offerListingID") || fd.get("items[0.base][offerListingId]") ? fd : null;
}

export interface CartItem {
  asin: string;
  itemId: string;
  title: string;
  price: number | null;
  quantity: number;
  outOfStock: boolean;
  /** Checked in the cart — Amazon's subtotal only counts checked items. */
  selected: boolean;
  /** Amazon only offers tick/untick on signed-in carts (guest rows have no selection state). */
  selectable: boolean;
  isPrime: boolean;
  image: string | null;
  url: string;
}

export function parseCart(html: string) {
  const doc = parse(html);
  const items: CartItem[] = doc
    .querySelectorAll("[data-asin][data-itemid][data-itemtype=active]")
    .map((el) => ({
      asin: el.getAttribute("data-asin")!,
      itemId: el.getAttribute("data-itemid")!,
      title: clean(el.getAttribute("data-producttitle")) || clean(el.querySelector(".sc-product-title .a-truncate-full")?.text),
      price: num(el.getAttribute("data-price")),
      quantity: num(el.getAttribute("data-quantity")) ?? 1,
      outOfStock: el.getAttribute("data-outofstock") === "1",
      selected: el.getAttribute("data-isselected") !== "0",
      selectable: ["0", "1"].includes(el.getAttribute("data-isselected") ?? ""),
      isPrime: el.getAttribute("data-isprimeasin") === "1",
      image: el.querySelector("img.sc-product-image")?.getAttribute("src") ?? null,
      url: `/dp/${el.getAttribute("data-asin")}`,
    }));
  const subtotalText = clean(doc.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")?.text) || null;
  const form = doc.querySelector("form#activeCartViewForm");
  const hidden = new URLSearchParams();
  for (const i of form?.querySelectorAll("input[type=hidden]") ?? []) {
    const n = i.getAttribute("name");
    if (n) hidden.append(n, i.getAttribute("value") ?? "");
  }
  return { items, subtotal: money(subtotalText), subtotalText, formAction: form?.getAttribute("action") ?? null, hidden };
}

// ── variants (size / colour …) ────────────────────────────────────────────────────────────────

export interface VariantDimension {
  /** Amazon's key, e.g. "size_name". */
  key: string;
  /** Display name, e.g. "Size". */
  name: string;
  values: string[];
}

export interface Variants {
  dimensions: VariantDimension[];
  /** Every buyable combination: child ASIN + its option values by display name. */
  combos: { asin: string; values: Record<string, string> }[];
  /** Options of the product page that was loaded. */
  selected: Record<string, string>;
  currentAsin: string | null;
}

/** JSON value that follows `"key" :` in a script (balanced braces/brackets; strings respected). */
function jsonAfter(html: string, key: string): unknown {
  const i = html.indexOf(`"${key}"`);
  if (i < 0) return undefined;
  let j = html.indexOf(":", i) + 1;
  while (/\s/.test(html[j]!)) j++;
  const open = html[j];
  if (open !== "{" && open !== "[" && open !== '"') return undefined;
  if (open === '"') {
    const m = html.slice(j).match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : undefined;
  }
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let k = j; k < html.length; k++) {
    const ch = html[k];
    if (inStr) {
      if (ch === "\\") k++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try {
        return JSON.parse(html.slice(j, k + 1).replace(/,\s*([\]}])/g, "$1")); // Amazon leaves trailing commas
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Amazon sometimes pads option names with stray punctuation (",Gold (Personalized)"). */
const tidyValue = (v: string) => v.replace(/^[\s,;|/-]+|[\s,;|/-]+$/g, "").replace(/\s+/g, " ");

export function parseVariants(html: string): Variants | null {
  const keys = jsonAfter(html, "dimensions") as string[] | undefined;
  const labels = (jsonAfter(html, "variationDisplayLabels") ?? {}) as Record<string, string>;
  const values = jsonAfter(html, "variationValues") as Record<string, string[]> | undefined;
  const map = jsonAfter(html, "dimensionToAsinMap") as Record<string, string> | undefined;
  if (!Array.isArray(keys) || !keys.length || !values || !map) return null;
  const dimensions = keys.filter((k) => Array.isArray(values[k])).map((k) => ({ key: k, name: labels[k] ?? k.replace(/_name$/, "").replace(/^./, (c) => c.toUpperCase()), values: values[k]!.map(tidyValue) }));
  if (!dimensions.length) return null;
  const combos = Object.entries(map).map(([idx, asin]) => {
    const parts = idx.split("_").map(Number);
    const v: Record<string, string> = {};
    dimensions.forEach((d, n) => {
      const val = d.values[parts[n]!];
      if (val != null) v[d.name] = val;
    });
    return { asin, values: v };
  });
  const sel = (jsonAfter(html, "selectedVariationValues") ?? {}) as Record<string, number>;
  const selected: Record<string, string> = {};
  for (const d of dimensions) if (sel[d.key] != null && sel[d.key]! >= 0) selected[d.name] = d.values[sel[d.key]!]!;
  const currentAsin = (jsonAfter(html, "currentAsin") as string | undefined) ?? null;
  return { dimensions, combos, selected, currentAsin };
}

/**
 * Find the child ASIN for options like { size: "medium", color: "white 6 pack" }. Names and values match
 * case-insensitively: exact first, then prefix, then contains. Ambiguous or unknown → a clear error.
 */
export function resolveVariant(v: Variants, choose: Record<string, string>): { asin: string; values: Record<string, string> } {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want: Record<string, string> = { ...v.selected };
  for (const [k, raw] of Object.entries(choose)) {
    const dim = v.dimensions.find((d) => norm(d.name) === norm(k) || norm(d.key).startsWith(norm(k)));
    if (!dim) throw new Error(`This product has no "${k}" option. Options: ${v.dimensions.map((d) => d.name).join(", ")}.`);
    const q = norm(raw);
    const exact = dim.values.filter((x) => norm(x) === q);
    const prefix = dim.values.filter((x) => norm(x).startsWith(q));
    const contains = dim.values.filter((x) => norm(x).includes(q));
    const hits = exact.length ? exact : prefix.length ? prefix : contains;
    if (hits.length !== 1) {
      throw new Error(
        hits.length
          ? `"${raw}" matches several ${dim.name} options: ${hits.join(" / ")}. Which one?`
          : `No ${dim.name} "${raw}". Available: ${dim.values.join(", ")}.`,
      );
    }
    want[dim.name] = hits[0]!;
  }
  const combo = v.combos.find((c) => v.dimensions.every((d) => !want[d.name] || c.values[d.name] === want[d.name]));
  if (!combo) throw new Error(`That combination (${Object.values(want).join(", ")}) isn't sold. Try another ${v.dimensions.map((d) => d.name).join(" or ")}.`);
  return combo;
}
