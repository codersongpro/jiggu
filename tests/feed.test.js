// 제휴 피드 변환 회귀 테스트 (리뷰 R05·R06 / 검수 Q03·Q05)
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const lib = require("../scripts/feed-import/lib.js");

const fixture = (n) => path.join(__dirname, "fixtures", "feeds", n);

function convert(file, opts) {
  const { rows, format } = lib.loadFeed(file);
  const mapping = lib.buildMapping(rows[0], {});
  const o = Object.assign({ shop: "테스트샵", sourceId: "feed-test", currencyFallback: null }, opts || {});
  const items = [];
  const skips = [];
  rows.forEach((row, i) => {
    const r = lib.toItem(row, mapping, o, i);
    if (r.skip) skips.push(r.skip);
    else items.push(r.item);
  });
  return { items, skips, mapping, format, rows };
}

test("Q05 - Google Shopping의 g:price 단독 상품도 정상 변환된다", () => {
  const { items, format } = convert(fixture("google-shopping.xml"));
  assert.strictEqual(format, "XML");
  const jp = items.find((i) => i.sku === "SKU-JP-1");
  assert.ok(jp, "g:price만 있는 상품이 버려지면 안 된다");
  assert.strictEqual(jp.salePrice, 12800, "¥12,800이 12.8로 읽히면 안 된다");
  assert.strictEqual(jp.currency, "JPY");
  assert.strictEqual(jp.marketCountry, "JP");
});

test("Q05 - XML 엔티티와 CDATA를 제대로 해석한다", () => {
  const { items } = convert(fixture("google-shopping.xml"));
  const jp = items.find((i) => i.sku === "SKU-JP-1");
  assert.strictEqual(jp.name, "Wool Coat & Scarf Set", "&amp;가 그대로 남으면 안 된다");
  const gb = items.find((i) => i.sku === "SKU-GB-2");
  assert.strictEqual(gb.name, "Merino Jumper <Slim>");
});

test("Q03 - 속성으로 온 GBP를 USD로 바꾸지 않는다", () => {
  const { items } = convert(fixture("google-shopping.xml"));
  const gb = items.find((i) => i.sku === "SKU-GB-2");
  assert.strictEqual(gb.currency, "GBP");
  assert.strictEqual(gb.salePrice, 19.99);
  assert.strictEqual(gb.marketCountry, "GB");
  assert.strictEqual(gb.region, null, "영국을 EU 원가 프로필에 넣으면 안 된다");
});

test("R06 - 재고 수량 10은 재고 있음, 0/out of stock은 건너뛴다", () => {
  const { items, skips } = convert(fixture("google-shopping.xml"));
  assert.ok(items.some((i) => i.sku === "SKU-JP-1"), "수량 10인 상품이 품절 처리되면 안 된다");
  assert.ok(!items.some((i) => i.sku === "SKU-US-3"), "품절 상품은 제외");
  assert.ok(skips.includes("품절"));
});

test("Q03 - CSV의 미국/유럽 숫자 표기를 각각 맞게 읽는다", () => {
  const { items } = convert(fixture("cj-sample.csv"));
  const us = items.find((i) => i.sku === "C-1");
  assert.strictEqual(us.listPrice, 1299);
  assert.strictEqual(us.salePrice, 899);
  assert.strictEqual(us.currency, "USD");
  assert.strictEqual(us.offRate, 31);

  const eu = items.find((i) => i.sku === "C-2");
  assert.strictEqual(eu.listPrice, 1299, "1.299,00은 1299다");
  assert.strictEqual(eu.salePrice, 999);
  assert.strictEqual(eu.currency, "EUR");
  assert.strictEqual(eu.region, "EU");
});

test("CSV 따옴표·줄바꿈·이스케이프 처리 회귀", () => {
  const { items, rows } = convert(fixture("cj-sample.csv"));
  assert.strictEqual(rows.length, 3, "따옴표 안 줄바꿈이 행을 쪼개면 안 된다");
  assert.strictEqual(items.find((i) => i.sku === "C-1").name, "Leather Tote, Large");
  assert.ok(items.find((i) => i.sku === "C-2").name.includes("\n"));
  assert.strictEqual(items.find((i) => i.sku === "C-3").name, 'Say "Hello" Tee');
});

test("정가와 판매가가 같으면 할인으로 표시하지 않는다", () => {
  const { items } = convert(fixture("cj-sample.csv"));
  const same = items.find((i) => i.sku === "C-3");
  assert.strictEqual(same.onSale, false);
  assert.strictEqual(same.offRate, 0);
  assert.strictEqual(same.availability, "in_stock", "IN_STOCK 컬럼의 10은 재고 있음");
});

test("통화를 확인할 수 없으면 USD로 넘겨짚지 않고 건너뛴다", () => {
  const rows = [{ title: "No currency item", price: "10.00" }];
  const mapping = lib.buildMapping(rows[0], {});
  const r = lib.toItem(rows[0], mapping, { shop: "s", sourceId: "s", currencyFallback: null }, 0);
  assert.ok(r.skip, "통화 불명 상품을 임의 통화로 넣으면 안 된다");
});

test("javascript: 링크는 상품 URL로 받아들이지 않는다", () => {
  const rows = [{ title: "X", price: "10.00", currency: "USD", link: "javascript:alert(1)" }];
  const mapping = lib.buildMapping(rows[0], {});
  const r = lib.toItem(rows[0], mapping, { shop: "s", sourceId: "s" }, 0);
  assert.strictEqual(r.item.sourceUrl, null);
});
