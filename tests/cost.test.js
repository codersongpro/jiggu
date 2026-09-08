// 원가 계산 회귀 테스트 (리뷰 R12 / 검수 Q10)
// 서버(api/_lib/landedCost.js)와 브라우저(web/shared/cost.js)가 같은 계산기를 쓰는지,
// 무게 구간 경계와 미지원 시장(GB) 처리가 맞는지 본다.
const test = require("node:test");
const assert = require("node:assert");
const { loadConfig, publicConfig } = require("../api/_lib/landedCost");
const cost = require("../web/shared/cost.js");

const cfg = loadConfig();
const item = (over) => Object.assign({ price: 100, currency: "USD", marketCountry: "US", category: "apparel", weight_kg: 1 }, over);

test("Q10 - 서버 설정과 브라우저에 내려주는 공개 설정의 계산 결과가 같다", () => {
  const web = publicConfig(cfg); // 브라우저가 GET /api/config로 받는 값
  for (const w of [0.4, 0.5, 1, 2.5, 5, 6, 10, 12.5]) {
    for (const market of ["US", "DE", "JP"]) {
      const cur = market === "US" ? "USD" : market === "JP" ? "JPY" : "EUR";
      const price = market === "JP" ? 30000 : 300;
      for (const mode of ["proxy", "business"]) {
        const a = cost.landedCost(cfg, item({ weight_kg: w, marketCountry: market, currency: cur, price }), mode);
        const b = cost.landedCost(web, item({ weight_kg: w, marketCountry: market, currency: cur, price }), mode);
        assert.strictEqual(a.totalKrw, b.totalKrw, `${market}/${w}kg/${mode} 총원가 불일치`);
        assert.strictEqual(a.intlShippingKrw, b.intlShippingKrw, `${market}/${w}kg 배송비 불일치`);
      }
    }
  }
});

test("Q10 - 6kg 배송비는 지역별 요율표를 따른다 (구간 경계 포함)", () => {
  // 5kg 초과 10kg 이하는 10kg 구간 요금이다
  assert.strictEqual(cost.intlShippingKrw(cfg, 6, "US"), 88000 + 2000);
  assert.strictEqual(cost.intlShippingKrw(cfg, 6, "EU"), 115000 + 2000);
  assert.strictEqual(cost.intlShippingKrw(cfg, 6, "JP"), 55000 + 2000);
  // 경계값은 그 구간에 포함된다
  assert.strictEqual(cost.intlShippingKrw(cfg, 0.5, "US"), 12000 + 2000);
  assert.strictEqual(cost.intlShippingKrw(cfg, 0.51, "US"), 17000 + 2000);
  // 10kg 초과분은 지역별 kg당 요금
  assert.strictEqual(cost.intlShippingKrw(cfg, 12, "US"), 88000 + 2 * 9000 + 2000);
  assert.strictEqual(cost.intlShippingKrw(cfg, 12, "EU"), 115000 + 2 * 12000 + 2000);
});

test("Q10 - 영국(GB)은 EU 규칙으로 계산하지 않고 '계산 미완료'로 남긴다", () => {
  const r = cost.landedCost(cfg, item({ marketCountry: "GB", currency: "GBP", price: 200 }), "proxy");
  assert.strictEqual(r.status, "incomplete");
  assert.strictEqual(r.totalKrw, null);
  assert.ok(/GB/.test(r.incompleteReason));
});

test("시장별 VAT가 다르면 그 값을 쓴다 (독일 19% / 이탈리아 22%)", () => {
  const de = cost.landedCost(cfg, item({ marketCountry: "DE", currency: "EUR", price: 119 }), "proxy");
  const it = cost.landedCost(cfg, item({ marketCountry: "IT", currency: "EUR", price: 122 }), "proxy");
  // 두 경우 모두 세전 100 EUR이므로 상품 원화가가 같아야 한다
  assert.strictEqual(de.itemKrw, it.itemKrw);
  assert.ok(de.notes.some((n) => n.includes("19%")));
  assert.ok(it.notes.some((n) => n.includes("22%")));
});

test("구매대행은 면세한도, 사업자는 전액 과세", () => {
  const cheap = cost.landedCost(cfg, item({ price: 100 }), "proxy");
  assert.strictEqual(cheap.taxFree, true);
  assert.strictEqual(cheap.dutyKrw, 0);

  const business = cost.landedCost(cfg, item({ price: 100 }), "business");
  assert.strictEqual(business.taxFree, false);
  assert.ok(business.dutyKrw > 0 && business.importVatKrw > 0);

  const over = cost.landedCost(cfg, item({ price: 500 }), "proxy");
  assert.strictEqual(over.taxFree, false, "면세한도 초과 시 전체 금액 과세");
});

test("등록되지 않은 통화는 원가를 계산하지 않는다", () => {
  const r = cost.landedCost(cfg, item({ currency: "CHF", marketCountry: "US" }), "proxy");
  assert.strictEqual(r.status, "incomplete");
});
