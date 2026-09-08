// 금액·통화 파싱 회귀 테스트 (리뷰 R05 / 검수 Q03)
const test = require("node:test");
const assert = require("node:assert");
const money = require("../web/shared/money.js");

test("Q03 - 나라별 숫자 표기를 원 단위 값으로 읽는다", () => {
  const cases = [
    ["¥12,800", null, 12800, "JPY"],
    ["12,800", "JPY", 12800, "JPY"],
    ["1,299.00 USD", null, 1299, "USD"],
    ["$1,299", null, 1299, "USD"],
    ["1.299,00", "EUR", 1299, "EUR"],
    ["€1.299,00", null, 1299, "EUR"],
    ["19.99 GBP", null, 19.99, "GBP"],
    ["£19.99", null, 19.99, "GBP"],
    ["1,299", "USD", 1299, "USD"],
    ["1.299", "EUR", 1299, "EUR"],
    ["49.5", "USD", 49.5, "USD"],
    ["1 299,00", "EUR", 1299, "EUR"],
    [12800, "JPY", 12800, "JPY"],
  ];
  for (const [raw, cur, expected, expectedCur] of cases) {
    const r = money.parseMoney(raw, { currency: cur });
    assert.strictEqual(r.value, expected, `${raw} → ${r.value} (기대 ${expected})`);
    assert.strictEqual(r.currency, expectedCur, `${raw}의 통화`);
  }
});

test("Q03 - 명시된 GBP를 USD로 바꾸지 않는다", () => {
  const r = money.parseMoney("19.99", { currency: "GBP", currencyHint: "USD" });
  assert.strictEqual(r.currency, "GBP");
  const r2 = money.parseMoney("19.99 GBP", { currencyHint: "USD" });
  assert.strictEqual(r2.currency, "GBP");
});

test("통화를 못 찾으면 임의로 USD를 넣지 않는다", () => {
  const r = money.parseMoney("19.99");
  assert.strictEqual(r.currency, null);
  assert.ok(r.warnings.some((w) => w.includes("통화")));
});

test("모호한 표기는 추측하지 않고 오류로 남긴다", () => {
  for (const raw of ["1.2.3", "12,34,567", "abc"]) {
    const r = money.parseMoney(raw, { currency: "USD" });
    assert.strictEqual(r.value, null, `${raw}는 파싱되면 안 된다`);
    assert.ok(r.warnings.length > 0);
  }
});

test("표시 통화가 명시값과 다르면 경고를 남기되 명시값을 쓴다", () => {
  const r = money.parseMoney("$100", { currency: "EUR" });
  assert.strictEqual(r.currency, "EUR");
  assert.ok(r.warnings.some((w) => w.includes("통화 불일치")));
});
