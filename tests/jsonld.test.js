// JSON-LD 추출 회귀 테스트 (리뷰 R08 / 검수 Q05)
const test = require("node:test");
const assert = require("node:assert");
const jsonld = require("../crawlers/jsonld.js");

const source = {
  sourceId: "rei-us",
  shopName: "REI",
  baseUrl: "https://www.rei.com",
  allowedHosts: ["www.rei.com"],
  currency: "USD",
  marketCountry: "US",
  region: "US",
  category: "apparel",
  productIdPattern: "^/product/(\\d+)/",
};
const url = "https://www.rei.com/product/184879/sample-hoodie";

test("Q05 - mainEntity가 객체인 경우에도 Product를 찾는다", () => {
  const block = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    mainEntity: {
      "@type": "Product",
      name: "Sahara Shade Hoodie",
      brand: { "@type": "Brand", name: "REI Co-op" },
      offers: { "@type": "Offer", price: "49.83", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    },
  });
  const r = jsonld.extractProduct([block], { url, source });
  assert.ok(r.item, r.error);
  assert.strictEqual(r.item.name, "Sahara Shade Hoodie");
  assert.strictEqual(r.item.salePrice, 49.83);
  assert.strictEqual(r.item.brand, "REI Co-op");
  assert.strictEqual(r.item.productId, "184879", "URL 패턴으로 상품 ID를 뽑아야 한다");
});

test("Q05 - @graph 안의 Product도 찾는다", () => {
  const block = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [] },
      {
        "@type": "Product",
        name: "Trailmade Pull-On Pants",
        offers: [{ "@type": "Offer", price: "39.99", priceCurrency: "USD", availability: "InStock" }],
      },
    ],
  });
  const r = jsonld.extractProduct([block], { url, source });
  assert.ok(r.item, r.error);
  assert.strictEqual(r.item.salePrice, 39.99);
});

test("R08 - AggregateOffer의 lowPrice/highPrice로 허위 할인을 만들지 않는다", () => {
  const block = JSON.stringify({
    "@type": "Product",
    name: "Range Pants",
    offers: { "@type": "AggregateOffer", lowPrice: "80.00", highPrice: "120.00", priceCurrency: "USD" },
  });
  const r = jsonld.extractProduct([block], { url, source });
  assert.ok(r.item, r.error);
  assert.strictEqual(r.item.onSale, false, "80~120을 33% 할인으로 읽으면 안 된다");
  assert.strictEqual(r.item.salePrice, 80);
  assert.strictEqual(r.item.maxPrice, 120);
  assert.strictEqual(r.item.priceVaries, true);
});

test("Q05 - ProductGroup/hasVariant의 옵션별 가격·재고를 따로 본다", () => {
  const block = JSON.stringify({
    "@type": "ProductGroup",
    name: "Merino Base Layer",
    brand: "Smartwool",
    hasVariant: [
      {
        "@type": "Product",
        sku: "V-S",
        size: "S",
        color: "Black",
        offers: { "@type": "Offer", price: "50.00", priceCurrency: "USD", availability: "OutOfStock" },
      },
      {
        "@type": "Product",
        sku: "V-M",
        size: "M",
        color: "Black",
        offers: { "@type": "Offer", price: "90.00", priceCurrency: "USD", availability: "InStock", listPrice: "120.00" },
      },
    ],
  });
  const r = jsonld.extractProduct([block], { url, source });
  assert.ok(r.item, r.error);
  assert.strictEqual(r.item.salePrice, 90, "품절 옵션(50)을 최저가로 쓰면 안 된다");
  assert.strictEqual(r.item.listPrice, 120, "같은 옵션의 정가만 쓴다");
  assert.strictEqual(r.item.sizes, "M");
  assert.strictEqual(r.item.brandId, "smartwool");
});

test("Q05 - AggregateOffer 안에 개별 Offer가 있으면 그쪽을 쓴다", () => {
  const block = JSON.stringify({
    "@type": "Product",
    name: "Jacket",
    offers: {
      "@type": "AggregateOffer",
      lowPrice: "100",
      highPrice: "300",
      priceCurrency: "USD",
      offers: [
        { "@type": "Offer", sku: "A", price: "100.00", priceCurrency: "USD", availability: "InStock" },
        { "@type": "Offer", sku: "B", price: "300.00", priceCurrency: "USD", availability: "InStock" },
      ],
    },
  });
  const r = jsonld.extractProduct([block], { url, source });
  assert.strictEqual(r.item.salePrice, 100);
  assert.strictEqual(r.item.onSale, false, "다른 옵션의 300을 정가로 쓰면 안 된다");
});

test("Q03 - 일본·유럽 표기의 가격을 통화와 함께 읽는다", () => {
  const jp = jsonld.extractProduct(
    [JSON.stringify({ "@type": "Product", name: "コート", offers: { price: "12,800", priceCurrency: "JPY", availability: "InStock" } })],
    { url: "https://www.beams.co.jp/item/beams/1", source: Object.assign({}, source, { sourceId: "beams-jp", currency: "JPY", marketCountry: "JP", region: "JP", productIdPattern: null }) }
  );
  assert.strictEqual(jp.item.salePrice, 12800);
  assert.strictEqual(jp.item.currency, "JPY");

  const eu = jsonld.extractProduct(
    [JSON.stringify({ "@type": "Product", name: "Jacke", offers: { price: "1.299,00", priceCurrency: "EUR", availability: "InStock" } })],
    { url: "https://www.bergfreunde.de/p/1", source: Object.assign({}, source, { sourceId: "bergfreunde-de", currency: "EUR", marketCountry: "DE", region: "EU", allowedHosts: ["www.bergfreunde.de"], productIdPattern: null }) }
  );
  assert.strictEqual(eu.item.salePrice, 1299);
  assert.strictEqual(eu.item.currency, "EUR");
});

test("깨진 JSON-LD 블록이 섞여 있어도 정상 블록을 읽는다", () => {
  const good = JSON.stringify({ "@type": "Product", name: "OK", offers: { price: "10", priceCurrency: "USD", availability: "InStock" } });
  const r = jsonld.extractProduct(["{broken", good], { url, source });
  assert.ok(r.item);
  assert.ok(r.warnings.some((w) => w.includes("블록")));
});

test("가격이 없는 Product는 오류로 남기고 만들어내지 않는다", () => {
  const r = jsonld.extractProduct([JSON.stringify({ "@type": "Product", name: "No price" })], { url, source });
  assert.ok(!r.item);
  assert.ok(r.error);
});

test("통화를 알 수 없으면 상품을 만들지 않는다", () => {
  const noCurrencySource = Object.assign({}, source, { currency: null });
  const r = jsonld.extractProduct(
    [JSON.stringify({ "@type": "Product", name: "X", offers: { price: "10", availability: "InStock" } })],
    { url, source: noCurrencySource }
  );
  assert.ok(!r.item);
  assert.match(r.error, /통화/);
});
