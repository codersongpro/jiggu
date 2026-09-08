// 옵션(variant)별 가격·재고 결합 회귀 테스트 (리뷰 R04·R06 / 검수 Q04)
const test = require("node:test");
const assert = require("node:assert");
const offers = require("../web/shared/offers.js");

test("Q04 - 서로 다른 옵션의 판매가와 정가를 섞지 않는다", () => {
  // 옵션 A: 50 판매 / 100 정가, 옵션 B: 80 판매 / 200 정가
  const s = offers.summarizeOffers([
    { variantId: "A", price: 50, compareAtPrice: 100, currency: "USD", availability: true },
    { variantId: "B", price: 80, compareAtPrice: 200, currency: "USD", availability: true },
  ]);
  assert.strictEqual(s.salePrice, 50);
  assert.strictEqual(s.listPrice, 100, "정가는 선택된 옵션(A)의 것이어야 한다");
  assert.strictEqual(s.offRate, 50, "50/200으로 계산한 75%가 나오면 안 된다");
});

test("Q04 - 재고가 확인된 옵션만 최저가 후보다", () => {
  const s = offers.summarizeOffers([
    { variantId: "A", price: 30, currency: "USD", availability: "OutOfStock" },
    { variantId: "B", price: 90, currency: "USD", availability: "InStock" },
  ]);
  assert.strictEqual(s.salePrice, 90);
  assert.strictEqual(s.availability, "in_stock");
});

test("Q04 - 전부 품절이면 품절로 표시한다", () => {
  const s = offers.summarizeOffers([
    { variantId: "A", price: 30, currency: "USD", availability: "OutOfStock" },
    { variantId: "B", price: 90, currency: "USD", availability: false },
  ]);
  assert.strictEqual(s.availability, "out_of_stock");
});

test("Q04 - 재고 미확인 옵션은 구매 가능한 최저가로 섞지 않는다", () => {
  const s = offers.summarizeOffers([
    { variantId: "A", price: 30, currency: "USD" }, // availability 없음
    { variantId: "B", price: 90, currency: "USD", availability: "InStock" },
  ]);
  assert.strictEqual(s.salePrice, 90, "재고 확인된 옵션이 있으면 그 중에서 고른다");

  const unknownOnly = offers.summarizeOffers([{ variantId: "A", price: 30, currency: "USD" }]);
  assert.strictEqual(unknownOnly.availability, "unknown");
});

test("Q04 - AggregateOffer의 lowPrice/highPrice는 할인 근거가 아니다", () => {
  const s = offers.summarizeOffers([
    { priceRange: true, minPrice: 80, maxPrice: 120, currency: "USD" },
  ]);
  assert.strictEqual(s.onSale, false, "80~120을 33% 할인으로 읽으면 안 된다");
  assert.strictEqual(s.offRate, 0);
  assert.strictEqual(s.minPrice, 80);
  assert.strictEqual(s.maxPrice, 120);
  assert.ok(s.warnings.some((w) => w.includes("가격 범위")));
});

test("R06 - 재고 수량 10은 재고 있음, 0은 품절", () => {
  assert.strictEqual(offers.normalizeAvailability("10"), "in_stock");
  assert.strictEqual(offers.normalizeAvailability(10), "in_stock");
  assert.strictEqual(offers.normalizeAvailability("0"), "out_of_stock");
  assert.strictEqual(offers.normalizeAvailability("out of stock"), "out_of_stock");
  assert.strictEqual(offers.normalizeAvailability("https://schema.org/InStock"), "in_stock");
  assert.strictEqual(offers.normalizeAvailability("in stock"), "in_stock");
  assert.strictEqual(offers.normalizeAvailability(""), "unknown");
});

test("정가가 판매가보다 낮으면 할인으로 치지 않는다", () => {
  const s = offers.summarizeOffers([
    { variantId: "A", price: 100, compareAtPrice: 80, currency: "USD", availability: true },
  ]);
  assert.strictEqual(s.onSale, false);
  assert.strictEqual(s.listPrice, null);
});

test("재고 있는 옵션의 사이즈만 노출한다", () => {
  const sizes = offers.availableSizes([
    { variantId: "A", price: 10, size: "S", availability: true },
    { variantId: "B", price: 10, size: "M", availability: false },
  ]);
  assert.deepStrictEqual(sizes, ["S"]);
});
