// 국내 시세 비교 API 테스트 — 네이버 API는 가짜 fetch로 대신한다
const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/korea-price.js");

function fakeRes() {
  return {
    code: null,
    body: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

async function call(query, responder) {
  const original = global.fetch;
  const env = { id: process.env.NAVER_CLIENT_ID, secret: process.env.NAVER_CLIENT_SECRET };
  process.env.NAVER_CLIENT_ID = "test-id";
  process.env.NAVER_CLIENT_SECRET = "test-secret";
  const calls = [];
  global.fetch = async (url) => {
    calls.push(new URL(String(url)));
    const items = responder(new URL(String(url)));
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
  const res = fakeRes();
  try {
    await handler({ query }, res);
  } finally {
    global.fetch = original;
    if (env.id === undefined) delete process.env.NAVER_CLIENT_ID; else process.env.NAVER_CLIENT_ID = env.id;
    if (env.secret === undefined) delete process.env.NAVER_CLIENT_SECRET; else process.env.NAVER_CLIENT_SECRET = env.secret;
  }
  return { res, calls };
}

const naverItem = (title, lprice) => ({ title: `<b>${title}</b>`, lprice: String(lprice), mallName: "몰", link: "https://shopping.naver.com/x" });

test("정확도순으로 받아 중고·렌탈·해외직구를 빼고 그 안에서 최저가·중간값·차액을 낸다", async () => {
  const { res, calls } = await call({ q: "파타고니아 Retro-X", landedKrw: "200000" }, () => [
    naverItem("파타고니아 레트로X 자켓", 320000),
    naverItem("파타고니아 레트로X 베스트", 250000),
    naverItem("파타고니아 레트로X", 280000),
  ]);
  const url = calls[0];
  assert.strictEqual(url.searchParams.get("sort"), "sim");
  assert.strictEqual(url.searchParams.get("exclude"), "used:rental:cbshop");
  const b = res.body;
  assert.strictEqual(b.available, true);
  assert.strictEqual(b.cheapestKrw, 250000);
  assert.strictEqual(b.medianKrw, 280000);
  assert.strictEqual(b.diffKrw, -50000, "음수면 해외가 더 싸다");
  assert.strictEqual(b.savingRate, 20);
  assert.deepStrictEqual(b.results.map((r) => r.priceKrw), [250000, 280000, 320000], "가격 낮은 순");
  assert.strictEqual(b.results[0].title, "파타고니아 레트로X 베스트", "HTML 태그 제거");
  assert.strictEqual(b.shortened, false);
});

test("결과가 없으면 앞 단어만 남긴 짧은 검색어로 한 번 더 찾는다", async () => {
  const { res, calls } = await call({ q: "파타고니아 Classic Retro-X Fleece Jacket Natural" }, (url) =>
    url.searchParams.get("query").split(" ").length > 4 ? [] : [naverItem("파타고니아 레트로X", 280000)]
  );
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(res.body.usedQuery, "파타고니아 Classic Retro-X Fleece");
  assert.strictEqual(res.body.shortened, true);
  assert.strictEqual(res.body.cheapestKrw, 280000);
  assert.strictEqual(res.body.diffKrw, null, "원가를 안 보냈으면 차액은 없다");
});

test("키가 없으면 설정 안내만 돌려준다", async () => {
  const saved = { id: process.env.NAVER_CLIENT_ID, secret: process.env.NAVER_CLIENT_SECRET };
  delete process.env.NAVER_CLIENT_ID;
  delete process.env.NAVER_CLIENT_SECRET;
  const res = fakeRes();
  await handler({ query: { q: "코치 가방" } }, res);
  if (saved.id !== undefined) process.env.NAVER_CLIENT_ID = saved.id;
  if (saved.secret !== undefined) process.env.NAVER_CLIENT_SECRET = saved.secret;
  assert.strictEqual(res.body.available, false);
  assert.match(res.body.reason, /NAVER_CLIENT_ID/);
});

test("보조 함수", () => {
  assert.strictEqual(handler.shortenQuery("a b c"), null);
  assert.strictEqual(handler.median([3, 1, 2, 10]), 3); // (2+3)/2 반올림
  assert.strictEqual(handler.median([]), null);
});
