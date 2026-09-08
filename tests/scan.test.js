// 서버 스캔 회귀 테스트 (리뷰 R01·R02·R03·R04 / 검수 Q01·Q02)
// 네트워크를 쓰지 않고 global fetch를 가짜 응답으로 바꿔 실행한다.
const test = require("node:test");
const assert = require("node:assert");
const scan = require("../api/scan.js");
const { normalizeProduct } = require("../api/_lib/shopify.js");

function shopifyProduct(id, over) {
  return Object.assign(
    {
      id,
      title: "Test Tee " + id,
      handle: "test-tee-" + id,
      vendor: "Stance",
      product_type: "T-Shirts",
      images: [{ src: "https://cdn.example.com/a.jpg" }],
      options: [{ name: "Size" }, { name: "Color" }],
      variants: [
        { id: id * 10 + 1, sku: "SKU" + id, price: "50.00", compare_at_price: "100.00", available: true, option1: "S", option2: "Black", grams: 300 },
        { id: id * 10 + 2, sku: "SKU" + id + "B", price: "80.00", compare_at_price: "200.00", available: true, option1: "M", option2: "Black", grams: 300 },
      ],
    },
    over || {}
  );
}

function fakeRes() {
  return {
    code: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

/** @param {(url:string)=>{status?:number, body?:string, headers?:object, throw?:Error}} responder */
function withFetch(responder, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("frankfurter.dev")) throw new Error("환율 API 차단(테스트)");
    const r = responder(String(url)) || {};
    if (r.throw) throw r.throw;
    const headers = new Map(Object.entries(r.headers || {}));
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
      text: async () => (r.body === undefined ? JSON.stringify({ products: [] }) : r.body),
      json: async () => JSON.parse(r.body || "{}"),
    };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    global.fetch = original;
  });
}

async function runScan(query, responder) {
  const res = fakeRes();
  let calls;
  await withFetch(responder, async (c) => {
    calls = c;
    await scan({ query }, res);
  });
  return { body: res.body, code: res.code, calls };
}

/** cursor를 끝까지 소비하며 전체를 모은다 */
async function runAll(query, responder, maxChunks) {
  const all = { items: [], sourceResults: [], calls: [], chunks: 0 };
  let cursor = undefined;
  for (let i = 0; i < (maxChunks || 200); i++) {
    const { body, calls } = await runScan(Object.assign({}, query, cursor ? { cursor } : {}), responder);
    all.items.push(...body.items);
    all.sourceResults.push(...body.sourceResults);
    all.calls.push(...calls.filter((u) => !u.includes("frankfurter")));
    all.chunks++;
    all.plannedSources = body.plannedSources;
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  all.finished = !cursor;
  return all;
}

const okBody = JSON.stringify({ products: [shopifyProduct(1), shopifyProduct(2)] });

test("Q01/R02 - 브랜드를 지정하면 관련 소스만, 각 소스/페이지는 한 번씩만 요청한다", async () => {
  const all = await runAll({ brand: "스탠스" }, () => ({ body: okBody }));
  assert.ok(all.finished, "cursor를 끝까지 소비해야 한다");

  const unique = new Set(all.calls);
  assert.strictEqual(unique.size, all.calls.length, `중복 요청 발생: ${all.calls.length}회 / 고유 ${unique.size}개`);

  // 관련 없는 공식몰(예: 다른 브랜드)은 계획에 없어야 한다
  const planned = all.plannedSources.map((s) => s.sourceId);
  assert.ok(planned.includes("stance-us"), "Stance 공식몰이 포함돼야 한다");
  assert.ok(!planned.includes("kith-us"), "관련 없는 브랜드 공식몰이 포함되면 안 된다");
  // 편집숍은 vendor로 섞여 나올 수 있어 포함한다
  assert.ok(all.plannedSources.some((s) => s.kind === "multi_brand"));

  // 지정한 브랜드의 상품만 남는다
  assert.ok(all.items.length > 0);
  all.items.forEach((it) => assert.strictEqual(it.brandId, "stance"));
});

test("Q01 - 전체 스캔도 소스당 페이지를 중복 없이 진행한다", async () => {
  // 2페이지짜리 소스: page1이 가득 차면 page2까지 이어간다
  const full = JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => shopifyProduct(i + 1)) });
  const responder = (url) => (url.includes("page=1") ? { body: full } : { body: JSON.stringify({ products: [] }) });

  const all = await runAll({ onlyPopular: "1" }, responder, 50);
  const unique = new Set(all.calls);
  assert.strictEqual(unique.size, all.calls.length, "같은 소스/페이지를 두 번 요청하면 안 된다");
  assert.ok(all.calls.some((u) => u.includes("page=2")), "가득 찬 페이지 뒤에는 다음 페이지를 이어받아야 한다");
});

test("Q02 - 잘못된 JSON은 parse_error다 (성공 0건이 아니다)", async () => {
  const { body } = await runScan({ brand: "스탠스" }, () => ({ body: "{not json" }));
  const sr = body.sourceResults[0];
  assert.strictEqual(sr.status, "parse_error");
  assert.strictEqual(body.sitesOk, 0);
  assert.strictEqual(body.sitesFailed, 1);
});

test("R03 - products 배열이 없는 정상 JSON도 성공 0건으로 처리하지 않는다", async () => {
  const { body } = await runScan({ brand: "스탠스" }, () => ({ body: JSON.stringify({ errors: "Not Found" }) }));
  assert.strictEqual(body.sourceResults[0].status, "parse_error");
  assert.strictEqual(body.sitesOk, 0);
});

test("Q02 - HTTP 200인데 HTML이면 render_required, 챌린지 화면이면 blocked", async () => {
  const html = await runScan({ brand: "스탠스" }, () => ({ body: "<!DOCTYPE html><html><body>Shop</body></html>" }));
  assert.strictEqual(html.body.sourceResults[0].status, "render_required");

  const chl = await runScan({ brand: "스탠스" }, () => ({ body: "<html><head><title>Access denied</title></head></html>" }));
  assert.strictEqual(chl.body.sourceResults[0].status, "blocked");
});

test("Q02 - HTTP 상태별 분류: 403 blocked / 404 unsupported_endpoint / 429 rate_limited / 5xx http_error", async () => {
  const cases = [
    [403, "blocked"],
    [404, "unsupported_endpoint"],
    [410, "unsupported_endpoint"],
    [429, "rate_limited"],
    [503, "http_error"],
  ];
  for (const [status, expected] of cases) {
    const { body } = await runScan({ brand: "스탠스" }, () => ({ status, body: "", headers: { "retry-after": "120" } }));
    const sr = body.sourceResults[0];
    assert.strictEqual(sr.status, expected, `HTTP ${status} → ${sr.status}`);
    assert.strictEqual(sr.httpStatus, status);
    if (status === 429) assert.strictEqual(sr.retryAfter, "120", "Retry-After를 기록해야 한다");
  }
});

test("Q02 - 2페이지의 429는 숨기지 않고 진단에 남긴다", async () => {
  const full = JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => shopifyProduct(i + 1)) });
  const responder = (url) => (url.includes("page=1") ? { body: full } : { status: 429, body: "" });

  const first = await runScan({ brand: "스탠스" }, responder);
  assert.strictEqual(first.body.sourceResults[0].status, "ok", "1페이지는 정상 수집");
  assert.ok(first.body.nextCursor, "가득 찬 페이지 뒤에는 다음 페이지 cursor가 있어야 한다");

  const second = await runScan({ brand: "스탠스", cursor: first.body.nextCursor }, responder);
  const rl = second.body.sourceResults.find((r) => r.status === "rate_limited");
  assert.ok(rl, "후속 페이지의 429가 결과에 남아야 한다");
  assert.strictEqual(second.body.sitesFailed, 1);
});

test("Q02 - 타임아웃은 timeout으로 분류한다", async () => {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  const { body } = await runScan({ brand: "스탠스" }, () => ({ throw: err }));
  assert.strictEqual(body.sourceResults[0].status, "timeout");
});

test("cursor 검증 - 등록되지 않은 sourceId나 이상한 형식은 거부한다", async () => {
  const bad = await runScan({ brand: "스탠스", cursor: "../etc/passwd:1" }, () => ({ body: okBody }));
  assert.strictEqual(bad.code, 400);
  const unknown = await runScan({ brand: "스탠스", cursor: "not-a-source:1" }, () => ({ body: okBody }));
  assert.strictEqual(unknown.code, 400);
});

test("sourceId를 지정하면 그 판매처 안에서만 진행한다", async () => {
  const { body, calls } = await runScan({ sourceId: "stance-us" }, () => ({ body: okBody }));
  assert.strictEqual(body.plannedSources.length, 1);
  assert.ok(calls.every((u) => u.includes("frankfurter") || u.includes("stance.com")));
  assert.strictEqual(body.nextCursor, null);
});

test("R04 - Shopify 상품도 같은 variant의 가격/정가만 결합한다", () => {
  const source = {
    sourceId: "stance-us", shopName: "Stance", baseUrl: "https://www.stance.com",
    currency: "USD", marketCountry: "US", region: "US", category: "apparel", locale: "en-US",
  };
  const item = normalizeProduct(shopifyProduct(1), source);
  assert.strictEqual(item.salePrice, 50);
  assert.strictEqual(item.listPrice, 100, "다른 variant의 정가(200)를 끌어오면 안 된다");
  assert.strictEqual(item.sku, "SKU1");
  assert.strictEqual(item.brandId, "stance");
  assert.strictEqual(item.sourceUrl, "https://www.stance.com/products/test-tee-1");
});

test("R04 - 품절 variant의 가격을 최저가로 쓰지 않는다", () => {
  const source = { sourceId: "stance-us", shopName: "Stance", baseUrl: "https://www.stance.com", currency: "USD", marketCountry: "US", region: "US", category: "apparel" };
  const p = shopifyProduct(1, {
    variants: [
      { id: 1, price: "20.00", compare_at_price: "40.00", available: false, option1: "S", grams: 200 },
      { id: 2, price: "60.00", compare_at_price: "90.00", available: true, option1: "M", grams: 200 },
    ],
  });
  const item = normalizeProduct(p, source);
  assert.strictEqual(item.salePrice, 60);
  assert.strictEqual(item.sizes, "M", "품절 사이즈를 판매 가능한 것처럼 보여주면 안 된다");
});
