// 실제 Chromium으로 어댑터 글루 코드를 확인한다 (네트워크는 쓰지 않는다).
// Playwright의 route 가로채기로 fixture HTML을 돌려주므로 외부 사이트에 접속하지 않는다.
// Playwright나 브라우저 바이너리가 없는 환경에서는 건너뛴다.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

let chromium = null;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  chromium = null;
}

const rei = require("../crawlers/rei-us.js");

const SOURCE = {
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

const fx = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "html", name), "utf-8");

const ROUTES = {
  "https://www.rei.com/c/clothing": () => fx("rei-listing.html"),
  "https://www.rei.com/product/184879/sample-hoodie": () => fx("rei-product.html"),
  "https://www.rei.com/product/235803/sample-pants": () => fx("rei-product-variants.html"),
};

async function launch() {
  // 이미지에 설치된 Chromium 경로를 환경변수로 지정할 수 있게 한다
  // (예: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome)
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ locale: "en-US" });
  await context.route("**/*", async (route) => {
    const url = route.request().url().split("?")[0];
    const body = ROUTES[url];
    if (!body) return route.fulfill({ status: 404, contentType: "text/html", body: "<html>not found</html>" });
    return route.fulfill({ status: 200, contentType: "text/html", body: body() });
  });
  return { browser, context };
}

test("브라우저 실행 경로 — 목록에서 상품 링크를 찾고 상세에서 옵션 가격을 읽는다", async (t) => {
  if (!chromium) return t.skip("playwright 미설치");
  let session;
  try {
    session = await launch();
  } catch (e) {
    return t.skip("chromium 실행 불가: " + e.message);
  }
  const { browser, context } = session;
  try {
    const page = await context.newPage();

    const discovery = await rei.discoverProducts({ page, source: SOURCE, cursor: null, limit: 10 });
    assert.deepStrictEqual(discovery.links.map((l) => l.productId).sort(), ["184879", "235803"]);

    const simple = await rei.fetchOffers({ page, source: SOURCE, url: "https://www.rei.com/product/184879/sample-hoodie" });
    assert.strictEqual(simple.status, "ok", simple.error);
    assert.strictEqual(simple.item.name, "Sahara Shade Hoodie");
    assert.strictEqual(simple.item.salePrice, 49.83);
    assert.strictEqual(simple.item.listPrice, 79.95);
    assert.strictEqual(simple.item.currency, "USD");
    assert.strictEqual(simple.item.brand, "REI Co-op");

    const variants = await rei.fetchOffers({ page, source: SOURCE, url: "https://www.rei.com/product/235803/sample-pants" });
    assert.strictEqual(variants.status, "ok", variants.error);
    assert.strictEqual(variants.item.salePrice, 59.0, "품절 옵션(39)을 최저가로 쓰면 안 된다");
    assert.strictEqual(variants.item.sizes, "M / L");
    assert.strictEqual(variants.item.brandId, "patagonia");

    const missing = await rei.fetchOffers({ page, source: SOURCE, url: "https://www.rei.com/product/999999/gone" });
    assert.strictEqual(missing.status, "unsupported_endpoint");
    await page.close();
  } finally {
    await browser.close();
  }
});
