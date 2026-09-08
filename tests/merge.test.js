// 병합·데이터 보존 회귀 테스트 (리뷰 R09·R10 / 검수 Q07·Q08)
const test = require("node:test");
const assert = require("node:assert");
const schema = require("../web/shared/schema.js");
const merge = require("../web/shared/merge.js");

function file(sourceId, items, srPatch) {
  return {
    schemaVersion: 2,
    runId: "run-" + sourceId,
    collectedAt: new Date().toISOString(),
    sourceResults: [
      Object.assign(
        { sourceId, status: "ok", complete: true, scope: { kind: "listing", value: null } },
        srPatch || {}
      ),
    ],
    items,
  };
}

const product = (sourceId, id, over) =>
  Object.assign(
    {
      sourceId,
      productId: id,
      variantId: "v1",
      name: "Test Product " + id,
      brand: "Patagonia",
      currency: "USD",
      salePrice: 100,
      listPrice: 150,
      marketCountry: "US",
      region: "US",
      sourceUrl: `https://www.rei.com/product/${id}/x`,
      sourceShop: "REI",
    },
    over || {}
  );

test("Q07 - REI Patagonia 결과 뒤에 REI Arc'teryx를 가져와도 앞 상품이 남는다", () => {
  const v1 = schema.validateResult(
    file("rei-us", [product("rei-us", "1", { brand: "Patagonia" })], { scope: { kind: "brand", value: "patagonia" } })
  );
  const v2 = schema.validateResult(
    file("rei-us", [product("rei-us", "2", { brand: "Arc’teryx" })], { scope: { kind: "brand", value: "arcteryx" } })
  );
  assert.ok(v1.ok && v2.ok, JSON.stringify([v1.errors, v2.errors]));

  let state = merge.mergeResult(merge.emptyState(), v1.result).state;
  const out = merge.mergeResult(state, v2.result);
  assert.strictEqual(out.state.items.length, 2, "다른 브랜드 수집 범위가 서로를 지우면 안 된다");
  assert.strictEqual(out.removed, 0);
});

test("Q07 - 같은 파일을 두 번 가져와도 중복되지 않는다", () => {
  const v = schema.validateResult(file("rei-us", [product("rei-us", "1"), product("rei-us", "2")]));
  let state = merge.mergeResult(merge.emptyState(), v.result).state;
  const again = merge.mergeResult(state, v.result);
  assert.strictEqual(again.state.items.length, 2);
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.updated, 2);
});

test("Q07 - 완전 수집(complete)으로 확인된 범위에서만 사라진 상품을 정리한다", () => {
  const first = schema.validateResult(file("rei-us", [product("rei-us", "1"), product("rei-us", "2")]));
  let state = merge.mergeResult(merge.emptyState(), first.result).state;

  // 같은 범위를 끝까지 다시 수집했더니 2번이 사라졌다 → 정리한다
  const complete = schema.validateResult(file("rei-us", [product("rei-us", "1")]));
  const afterComplete = merge.mergeResult(state, complete.result);
  assert.strictEqual(afterComplete.state.items.length, 1);
  assert.strictEqual(afterComplete.removed, 1);
});

test("Q07 - 부분 수집(partial)은 기존 상품을 지우지 않는다", () => {
  const first = schema.validateResult(file("rei-us", [product("rei-us", "1"), product("rei-us", "2")]));
  let state = merge.mergeResult(merge.emptyState(), first.result).state;

  const partial = schema.validateResult(
    file("rei-us", [product("rei-us", "1")], { status: "partial", complete: false, nextCursor: "p2" })
  );
  const after = merge.mergeResult(state, partial.result);
  assert.strictEqual(after.state.items.length, 2, "부분 수집이 기존 상품을 지우면 안 된다");
  assert.strictEqual(after.removed, 0);
});

test("Q07 - 구형(schemaVersion 없음) 파일은 추가만 하고 삭제하지 않는다", () => {
  const first = schema.validateResult(file("rei-us", [product("rei-us", "1"), product("rei-us", "2")]));
  let state = merge.mergeResult(merge.emptyState(), first.result).state;

  const legacy = schema.validateResult({
    scannedAt: new Date().toISOString(),
    items: [product("rei-us", "3")],
  });
  assert.ok(legacy.ok, JSON.stringify(legacy.errors));
  assert.ok(legacy.result.sourceResults.every((sr) => sr.complete === false));
  const after = merge.mergeResult(state, legacy.result);
  assert.strictEqual(after.state.items.length, 3);
});

test("R09 - 다른 판매처(sourceId)의 결과를 덮어쓰지 않는다", () => {
  const rei = schema.validateResult(file("rei-us", [product("rei-us", "1")]));
  const beams = schema.validateResult(
    file("beams-jp", [
      product("beams-jp", "9", { currency: "JPY", marketCountry: "JP", region: "JP", sourceShop: "BEAMS", sourceUrl: "https://www.beams.co.jp/item/9" }),
    ])
  );
  let state = merge.mergeResult(merge.emptyState(), rei.result).state;
  state = merge.mergeResult(state, beams.result).state;
  assert.strictEqual(state.items.length, 2);
  assert.deepStrictEqual([...new Set(state.items.map((i) => i.sourceId))].sort(), ["beams-jp", "rei-us"]);
});

test("Q08 - 잘못된 입력은 반영 전에 거부한다", () => {
  const bad = [
    { items: [] },
    { items: [{ name: "x" }] }, // 통화·가격 없음
    { items: [Object.assign(product("rei-us", "1"), { currency: "달러" })] },
    { items: [Object.assign(product("rei-us", "1"), { salePrice: -5 })] },
    { items: [Object.assign(product("rei-us", "1"), { marketCountry: "USA" })] },
    { items: [Object.assign(product("rei-us", "1"), { sourceUrl: "javascript:alert(1)" })] },
    { schemaVersion: 99, items: [product("rei-us", "1")] },
    "문자열",
  ];
  for (const input of bad) {
    const r = schema.validateResult(input);
    assert.strictEqual(r.ok, false, `거부돼야 함: ${JSON.stringify(input).slice(0, 60)}`);
    assert.ok(r.errors.length > 0);
  }
});

test("Q08 - 한도를 넘는 파일은 거부한다", () => {
  const many = Array.from({ length: schema.LIMITS.MAX_OFFERS + 1 }, (_, i) => product("rei-us", String(i)));
  const r = schema.validateResult({ schemaVersion: 2, items: many });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes("너무 많"));
});

test("개별 상품 404는 상태만 바꾸고 지우지 않는다", () => {
  const v = schema.validateResult(file("rei-us", [product("rei-us", "1")]));
  const state = merge.mergeResult(merge.emptyState(), v.result).state;
  const key = state.items[0].key;
  const after = merge.mergeResult(state, {
    collectedAt: new Date().toISOString(),
    items: [],
    sourceResults: [],
    itemStatuses: [{ key, availability: "gone" }],
  });
  assert.strictEqual(after.state.items.length, 1);
  assert.strictEqual(after.state.items[0].availability, "gone");
});

test("Q01 - 페이지 조각(chunk)은 끝까지 소비했을 때만 complete=true가 된다", () => {
  const acc = merge.createAccumulator("run-1");
  acc.add({
    items: [product("rei-us", "1")],
    sourceResults: [{ sourceId: "rei-us", status: "ok", scope: { kind: "listing", value: null }, nextCursor: "p2", accepted: 1 }],
  });
  const mid = acc.finalize(false);
  assert.strictEqual(mid.sourceResults[0].complete, false, "아직 다음 페이지가 남았으면 완전 수집이 아니다");

  acc.add({
    items: [product("rei-us", "2")],
    sourceResults: [{ sourceId: "rei-us", status: "ok", scope: { kind: "listing", value: null }, nextCursor: null, accepted: 1 }],
  });
  const done = acc.finalize(true);
  assert.strictEqual(done.items.length, 2);
  assert.strictEqual(done.sourceResults[0].complete, true);
  assert.strictEqual(done.sourceResults[0].accepted, 2, "조각별 집계가 누적돼야 한다");
});

test("Q01/Q02 - 중간에 실패한 실행은 완전 수집으로 확정하지 않는다", () => {
  const acc = merge.createAccumulator("run-2");
  acc.add({
    items: [product("rei-us", "1")],
    sourceResults: [{ sourceId: "rei-us", status: "rate_limited", scope: { kind: "listing", value: null }, nextCursor: null }],
  });
  const out = acc.finalize(true);
  assert.strictEqual(out.sourceResults[0].complete, false);
});

test("수집 시각이 24시간을 넘으면 오래된 정보로 표시한다", () => {
  const old = { collectedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() };
  const fresh = { collectedAt: new Date().toISOString() };
  assert.strictEqual(merge.isStale(old), true);
  assert.strictEqual(merge.isStale(fresh), false);
});
