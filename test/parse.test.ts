import { describe, expect, test } from "bun:test";
import { asinFrom, buyBoxForm, parseCart, parseProduct, parseSearchPage, parseSearchStream } from "../src/parse.ts";

const B = "https://www.amazon.com";
const fx = (f: string) => Bun.file(new URL(`./fixtures/${f}`, import.meta.url)).text();

describe("asinFrom", () => {
  test("bare ASIN and product URLs", () => {
    expect(asinFrom("b0fb2wx15j")).toBe("B0FB2WX15J");
    expect(
      asinFrom("https://www.amazon.com/BEILUNER-Fountain-Trustworthy-Converter-Elegant-Professional/dp/B0FB2WX15J/ref=sxin_16_pa_sp?keywords=pen&psc=1"),
    ).toBe("B0FB2WX15J");
    expect(asinFrom("https://www.amazon.com/gp/product/B09PYPPD9L?th=1")).toBe("B09PYPPD9L");
    expect(() => asinFrom("https://www.amazon.com/s?k=pen")).toThrow();
  });
});

describe("search", () => {
  test("page HTML → results, total, refinements", async () => {
    const p = parseSearchPage(await fx("search.html"), B);
    expect(p.results.length).toBeGreaterThan(20);
    expect(p.total).toBeGreaterThan(1000);
    expect(p.hasNext).toBe(true);
    const organic = p.results.find((r) => !r.sponsored)!;
    expect(organic.asin).toMatch(/^[A-Z0-9]{10}$/);
    expect(organic.title.length).toBeGreaterThan(5);
    expect(organic.price).toBeGreaterThan(0);
    expect(organic.rating).toBeGreaterThan(0);
    expect(p.results.some((r) => r.sponsored)).toBe(true);
    for (const r of p.results) if (r.listPrice && r.price) expect(Number(r.listPrice.replace(/[^\d.]/g, ""))).toBeGreaterThan(r.price);
    expect(p.refinements.find((r) => r.group === "Brands")?.rh).toMatch(/^p_123:\d+$/);
    expect(p.refinements.some((r) => r.rh.includes("dynamic"))).toBe(false);
  });

  test("/s/query stream → results", async () => {
    const s = parseSearchStream(await fx("search-stream.txt"), B);
    expect(s.results.length).toBeGreaterThan(20);
    expect(s.hasNext).toBe(true);
    expect(new Set(s.results.map((r) => r.asin + r.sponsored)).size).toBe(s.results.length);
  });
});

describe("product", () => {
  test("fountain pen detail page", async () => {
    const html = await fx("product.html");
    const p = parseProduct(html, "B0FB2WX15J", B);
    expect(p.title).toContain("BEILUNER");
    expect(p.brand).toBe("BEILUNER");
    expect(p.price).toBeGreaterThan(0);
    expect(p.bullets.length).toBeGreaterThan(0);
    expect(p.images.length).toBeGreaterThan(0);
    expect(p.canAddToCart).toBe(true);
    const form = buyBoxForm(html)!;
    expect(form.get("ASIN")).toBe("B0FB2WX15J");
    expect(form.get("anti-csrftoken-a2z")).toBeTruthy();
    expect(form.has("submit.buy-now")).toBe(false);
  });

  // Shapes taken from live pages (Nov 2026): Amazon nests scripts inside #availability.
  test("availability is the visible text, without nested scripts", () => {
    const page = (inner: string) => `<span id="productTitle">Shirt</span><div id="availability">${inner}</div>`;
    const inStock = parseProduct(page(`<span class="a-color-success"> In Stock </span><script type="a-state" data-a-state='{"key":"x"}'>{"isInternal":false,"asin":"B0DFPDJXF1"}</script><br/>`), "B0DFPDJXF1", B);
    expect(inStock.availability).toBe("In Stock");
    const gone = parseProduct(page(`<div id="all-offers-display"><form class="aok-hidden"><input type="hidden" value="true"></form></div>
      <span class="a-color-price">Currently unavailable.</span><script type="application/javascript">P.when("A","load").execute(function(A){ ueLogError({}); });</script>`), "B0F493442R", B);
    expect(gone.availability).toBe("Currently unavailable.");
  });

  test("an unavailable page with an empty buy-box form is not addable", () => {
    const html = `<span id="productTitle">Shirt</span><div id="availability"><span>Currently unavailable.</span></div>
      <form id="addToCart"><input type="hidden" name="ASIN" value="B0F493442R"><input type="hidden" name="offerListingID" value=""></form>`;
    expect(parseProduct(html, "B0F493442R", B).canAddToCart).toBe(false);
    expect(buyBoxForm(html)).toBeNull();
    const buyable = html.replace('name="offerListingID" value=""', 'name="offerListingID" value="abc123"') + `<input id="add-to-cart-button" type="submit">`;
    expect(parseProduct(buyable, "B0F493442R", B).canAddToCart).toBe(true);
    expect(buyBoxForm(buyable)?.get("offerListingID")).toBe("abc123");
  });
});

describe("cart", () => {
  test("cart page → items, subtotal, delete form", async () => {
    const c = parseCart(await fx("cart.html"));
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ asin: "B0FB2WX15J", quantity: 1, outOfStock: false });
    expect(c.items[0]!.itemId).toBeTruthy();
    expect(c.subtotal).toBe(c.items[0]!.price);
    expect(c.formAction).toStartWith("/cart/");
    expect(c.hidden.get("anti-csrftoken-a2z")).toBeTruthy();
    expect(c.items[0]!.image).toMatch(/\/images\/I\/.+\.jpg$/);
  });
});
