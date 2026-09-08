// PC 수집기 회귀 테스트 (리뷰 R07·R11 / 검수 Q02·Q06)
// Playwright 대신 최소한의 가짜 page 객체를 써서 브라우저 없이 동작을 확인한다.
const test = require("node:test");
const assert = require("node:assert");
const generic = require("../crawlers/generic-jsonld.js");
const rei = require("../crawlers/rei-us.js");
const links = require("../crawlers/links.js");
const { ADAPTERS } = require("../crawlers");
const { crawlSource } = require("../scripts/local-crawler/crawl.js");

const REI = {
  sourceId: "rei-us",
  shopName: "REI",
  baseUrl: "https://www.rei.com",
  domain: "www.rei.com",
  allowedHosts: ["www.rei.com"],
  currency: "USD",
  marketCountry: "US",
  region: "US",
  category: "apparel",
  adapter: "rei-us",
  listingUrls: ["https://www.rei.com/c/clothing"],
  productIdPattern: "^/product/(\\d+)/",
  productLinkPattern: "^/product/\\d+/",
};

function productLd(name, price, over) {
  return JSON.stringify(
    Object.assign(
      {
        "@type": "Product",
        name,
        brand: { name: "Patagonia" },
        offers: { "@type": "Offer", price: String(price), priceCurrency: "USD", availability: "https://schema.org/InStock" },
      },
      over || {}
    )
  );
}

/**
 * 가짜 Playwright page.
 * @param {Object<string,{status?:number, hrefs?:string[], jsonld?:string[], html?:string, relNext?:string, lazy?:boolean}>} pages
 */
function fakePage(pages, log) {
  let current = null;
  let waited = [];
  return {
    waited,
    url: () => current,
    async goto(u) {
      current = u;
      if (log) log.push(u);
      const p = pages[u];
      if (!p) return { status: () => 404 };
      if (p.throw) throw new Error(p.throw);
      return { status: () => p.status || 200 };
    },
    async waitForSelector(sel) {
      const p = pages[current] || {};
      waited.push(sel);
      // lazy: 링크는 waitForSelector를 거친 뒤에야 나타난다
      if (p.lazy && sel.includes("product")) p.ready = true;
      if (sel.includes("ld+json") && !(p.jsonld || []).length) throw new Error("없음");
      if (sel.includes("a[href]") && !(p.hrefs || []).length) throw new Error("없음");
      return {};
    },
    async $$eval(sel) {
      const p = pages[current] || {};
      if (sel.includes("ld+json")) return p.jsonld || [];
      if (p.lazy && !p.ready) return []; // 렌더링 전에는 링크가 없다
      return p.hrefs || [];
    },
    async $eval(sel) {
      const p = pages[current] || {};
      if (p.relNext) return p.relNext;
      throw new Error("없음");
    },
    async content() {
      const p = pages[current] || {};
      return p.html || "<html></html>";
    },
    async close() {},
  };
}

test("R11 - 상대/절대/프로토콜 상대 링크를 같은 상품으로 모으고 외부 도메인은 거부한다", () => {
  const hrefs = [
    "/product/184879/sahara-hoodie",
    "https://www.rei.com/product/184879/sahara-hoodie?color=black",
    "//www.rei.com/product/235803/trailmade-pants",
    "https://evil.example/?u=www.rei.com/product/1/x",
    "https://www.rei.com/search?q=jacket",
    "javascript:void(0)",
  ];
  const { links: found } = links.collectProductLinks(hrefs, { baseUrl: "https://www.rei.com/c/clothing", source: REI });
  assert.deepStrictEqual(found.map((l) => l.productId), ["184879", "235803"]);
  assert.ok(found.every((l) => l.url.startsWith("https://www.rei.com/product/")));
});

test("Q06 - 사설 IP·비 http(s) 주소는 수집 대상이 되지 않는다", () => {
  const src = Object.assign({}, REI, { allowedHosts: ["localhost", "127.0.0.1"] });
  const { links: found } = links.collectProductLinks(["http://127.0.0.1/product/1/x", "http://localhost/product/2/x"], {
    baseUrl: "http://127.0.0.1/",
    source: src,
  });
  assert.strictEqual(found.length, 0);
});

test("R07 - 지연 렌더링 페이지에서도 상품 링크를 찾는다", async () => {
  const page = fakePage({
    "https://www.rei.com/c/clothing": { hrefs: ["/product/1/a", "/product/2/b"], lazy: true },
  });
  const r = await rei.discoverProducts({ page, source: REI, cursor: null, limit: 10 });
  assert.strictEqual(r.links.length, 2, "DOMContentLoaded 직후 빈 DOM에서 포기하면 안 된다");
  assert.ok(page.waited.some((s) => s.includes("product")), "준비 조건을 기다려야 한다");
});

test("R07 - 목록 2페이지를 cursor로 이어받는다", async () => {
  const page = fakePage({
    "https://www.rei.com/c/clothing": { hrefs: ["/product/1/a"] },
    "https://www.rei.com/c/clothing?page=2": { hrefs: ["/product/2/b"] },
  });
  const first = await rei.discoverProducts({ page, source: REI, cursor: null, limit: 10 });
  assert.ok(first.nextCursor, "다음 페이지 cursor가 있어야 한다");
  const second = await rei.discoverProducts({ page, source: REI, cursor: first.nextCursor, limit: 10 });
  assert.deepStrictEqual(second.links.map((l) => l.productId), ["2"]);
});

test("Q02 - 목록 403은 blocked, 상품 404는 그 상품만 건너뛴다", async () => {
  const blocked = fakePage({ "https://www.rei.com/c/clothing": { status: 403 } });
  const r = await rei.discoverProducts({ page: blocked, source: REI, cursor: null, limit: 10 });
  assert.strictEqual(r.status, "blocked");

  const page = fakePage({ "https://www.rei.com/product/1/a": { status: 404 } });
  const detail = await rei.fetchOffers({ page, source: REI, url: "https://www.rei.com/product/1/a" });
  assert.strictEqual(detail.status, "unsupported_endpoint");
  assert.strictEqual(detail.item, null);
});

test("R07 - [404, 정상] 순서에서 뒤의 정상 상품을 수집한다", async () => {
  const log = [];
  const page = fakePage(
    {
      "https://www.rei.com/c/clothing": { hrefs: ["/product/1/gone", "/product/2/ok"] },
      "https://www.rei.com/product/1/gone": { status: 404 },
      "https://www.rei.com/product/2/ok": { jsonld: [productLd("Better Sweater", 79.0)] },
    },
    log
  );
  const context = { newPage: async () => page };
  const { items, result } = await crawlSource(context, REI, { limit: 10, brandId: null, delayMs: 0 }, null);
  assert.strictEqual(items.length, 1, "404 하나가 뒤 상품 수집을 막으면 안 된다");
  assert.strictEqual(items[0].name, "Better Sweater");
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(result.accepted, 1);
});

test("한도(limit)에 걸려 끝나면 complete=false이고 이어받을 cursor가 남는다", async () => {
  const page = fakePage({
    "https://www.rei.com/c/clothing": { hrefs: ["/product/1/a", "/product/2/b"] },
    "https://www.rei.com/c/clothing?page=2": { hrefs: ["/product/3/c"] },
    "https://www.rei.com/product/1/a": { jsonld: [productLd("A", 10)] },
    "https://www.rei.com/product/2/b": { jsonld: [productLd("B", 20)] },
    "https://www.rei.com/product/3/c": { jsonld: [productLd("C", 30)] },
  });
  const context = { newPage: async () => page };
  const { items, result } = await crawlSource(context, REI, { limit: 1, brandId: null, delayMs: 0 }, null);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.status, "partial");
});

test("차단(429)이면 그 판매처를 중단하고 Retry-After를 남길 자리를 만든다", async () => {
  const page = fakePage({ "https://www.rei.com/c/clothing": { status: 429 } });
  const context = { newPage: async () => page };
  const { items, result } = await crawlSource(context, REI, { limit: 5, brandId: null, delayMs: 0 }, null);
  assert.strictEqual(items.length, 0);
  assert.strictEqual(result.status, "rate_limited");
  assert.strictEqual(result.complete, false);
});

test("브랜드 필터는 원격 검색이 없어도 발견 결과에서 걸러낸다", async () => {
  const page = fakePage({
    "https://www.rei.com/c/clothing": { hrefs: ["/product/1/a", "/product/2/b"] },
    "https://www.rei.com/product/1/a": { jsonld: [productLd("Nano Puff", 199, { brand: { name: "Patagonia" } })] },
    "https://www.rei.com/product/2/b": { jsonld: [productLd("Beta LT", 399, { brand: { name: "Arc’teryx" } })] },
  });
  const context = { newPage: async () => page };
  const { items } = await crawlSource(context, REI, { limit: 10, brandId: "patagonia", delayMs: 0 }, null);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].brandId, "patagonia");
});

test("REI 한 곳에서 서로 다른 브랜드가 함께 수집된다 (판매처 ≠ 브랜드)", async () => {
  const page = fakePage({
    "https://www.rei.com/c/clothing": { hrefs: ["/product/1/a", "/product/2/b"] },
    "https://www.rei.com/product/1/a": { jsonld: [productLd("Nano Puff", 199, { brand: { name: "Patagonia" } })] },
    "https://www.rei.com/product/2/b": { jsonld: [productLd("Beta LT", 399, { brand: { name: "Arc’teryx" } })] },
  });
  const context = { newPage: async () => page };
  const { items } = await crawlSource(context, REI, { limit: 10, brandId: null, delayMs: 0 }, null);
  assert.strictEqual(new Set(items.map((i) => i.brandId)).size, 2);
  items.forEach((i) => assert.strictEqual(i.sourceShop, "REI"));
});

test("등록된 어댑터 이름만 사용한다", () => {
  assert.ok(ADAPTERS["jsonld-browser"]);
  assert.ok(ADAPTERS["rei-us"]);
  assert.strictEqual(typeof generic.discoverProducts, "function");
  assert.strictEqual(typeof generic.fetchOffers, "function");
});

test("사이트맵 XML을 읽어 상품 URL 후보를 만든다", () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>https://www.rei.com/product/1/a</loc></url><url><loc>https://www.rei.com/c/clothing</loc></url></urlset>`;
  const parsed = links.parseSitemap(xml);
  assert.strictEqual(parsed.urls.length, 2);
  const { links: found } = links.collectProductLinks(parsed.urls, { baseUrl: "https://www.rei.com/", source: REI });
  assert.deepStrictEqual(found.map((l) => l.productId), ["1"]);

  const index = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.rei.com/sitemap-products.xml</loc></sitemap></sitemapindex>`;
  assert.deepStrictEqual(links.parseSitemap(index).sitemaps, ["https://www.rei.com/sitemap-products.xml"]);
});
