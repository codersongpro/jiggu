// 판매처 정본 목록 검증 (T01 / 리뷰 R02)
const test = require("node:test");
const assert = require("node:assert");
const targets = require("../config/targets.json");
const sources = require("../web/shared/sources.js");
const brands = require("../web/shared/brands.js");
const urls = require("../web/shared/urls.js");

const loaded = sources.loadSources(targets);

test("config/targets.json이 오류 없이 로드되고 sourceId가 중복되지 않는다", () => {
  assert.deepStrictEqual(loaded.errors, []);
  assert.ok(loaded.sources.length > 50, "판매처가 로드되어야 한다");
  const ids = loaded.sources.map((s) => s.sourceId);
  assert.strictEqual(new Set(ids).size, ids.length, "sourceId 중복");
});

test("모든 판매처의 baseUrl은 공개 http(s)이고 allowedHosts와 일치한다", () => {
  for (const s of loaded.sources) {
    assert.ok(urls.isPublicHttpUrl(s.baseUrl), `${s.sourceId}: baseUrl이 공개 URL이 아님`);
    const host = urls.parseUrl(s.baseUrl).hostname;
    assert.ok(urls.hostAllowed(host, s.allowedHosts), `${s.sourceId}: allowedHosts에 자기 호스트가 없음`);
  }
});

test("실제 수집 근거 없이 supported로 표시된 판매처가 없다", () => {
  for (const s of loaded.sources) {
    if (s.support.status === "supported") {
      assert.ok(s.support.checkedAt, `${s.sourceId}: supported인데 확인일이 없음`);
      assert.ok(s.support.environment, `${s.sourceId}: supported인데 실행 환경 기록이 없음`);
    }
  }
});

test("R02 - 브랜드를 지정하면 그 브랜드 공식몰과 편집숍만 고른다", () => {
  const all = sources.selectSources(loaded.sources, { runtime: "server" });
  const stance = sources.selectSources(loaded.sources, { runtime: "server", brandId: "stance" });
  assert.ok(stance.length < all.length, "브랜드 지정이 대상 수를 줄여야 한다");

  const officials = stance.filter((s) => s.kind === "official");
  assert.ok(officials.length >= 1, "Stance 공식몰이 포함돼야 한다");
  officials.forEach((s) => assert.strictEqual(s.brandId, "stance", `${s.sourceId}는 다른 브랜드 공식몰`));
  // 편집숍은 vendor로 그 브랜드가 섞여 나올 수 있으므로 남긴다
  assert.ok(stance.some((s) => s.kind === "multi_brand"));
  // 같은 소스를 두 번 요청하지 않는다
  const ids = stance.map((s) => s.sourceId);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test("한글 브랜드명으로도 같은 소스가 선택된다 (칩/드롭다운/검색 일치)", () => {
  const byEn = sources.selectSources(loaded.sources, { runtime: "server", brandId: "Stance" }).map((s) => s.sourceId);
  const byKr = sources.selectSources(loaded.sources, { runtime: "server", brandId: "스탠스" }).map((s) => s.sourceId);
  assert.deepStrictEqual(byKr, byEn);
  assert.strictEqual(brands.canonicalBrandId("스탠스"), "stance");
});

test("blocked 판매처는 스캔 대상에서 제외된다", () => {
  const selected = sources.selectSources(loaded.sources, {});
  assert.ok(selected.every((s) => s.support.status !== "blocked"));
  assert.ok(loaded.sources.some((s) => s.support.status === "blocked"), "blocked 기록 자체는 남아 있어야 한다");
});

test("국가 필터가 동작하고 8개 검증 대상 국가가 모두 등록돼 있다", () => {
  for (const c of ["US", "JP", "GB", "DE", "FR", "IT", "ES", "NL"]) {
    const list = sources.selectSources(loaded.sources, { marketCountries: [c] });
    assert.ok(list.length >= 1, `${c} 시장 판매처가 없음`);
    list.forEach((s) => assert.strictEqual(s.marketCountry, c));
  }
});

test("REI는 필수 검증 대상으로 등록돼 있고 상품 URL 패턴을 갖는다", () => {
  const rei = sources.findSource(loaded.sources, "rei-us");
  assert.ok(rei, "rei-us 소스가 있어야 한다");
  assert.strictEqual(rei.runtime, "pc");
  assert.strictEqual(rei.adapter, "rei-us");
  assert.ok(rei.listingUrls.some((u) => u.includes("/c/clothing")), "계획 4.2의 검증용 seed가 있어야 한다");
  assert.ok(rei.productIdPattern);
});

test("GB 시장은 원가 프로필이 비어 있어야 한다 (EU 규칙 전용 금지)", () => {
  const gb = loaded.sources.filter((s) => s.marketCountry === "GB");
  assert.ok(gb.length >= 1);
  gb.forEach((s) => assert.strictEqual(s.region, null, `${s.sourceId}: GB에 원가 프로필이 붙어 있음`));
});
