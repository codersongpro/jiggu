/* 수집 결과 데이터 계약 (schemaVersion 2) — 브라우저/Node 공용
 *
 * 서버 스캔(api/scan.js), PC 크롤러(scripts/local-crawler), 피드 변환기
 * (scripts/feed-import), 웹 가져오기가 전부 이 형식과 이 검증 함수를 쓴다.
 *
 * 핵심 원칙
 *  - 상품 키는 sourceId + 상품 식별자 + variant 식별자다. 브랜드+상품명이나
 *    구입처 이름만으로 지우거나 합치지 않는다(리뷰 R09).
 *  - 판매처별로 "이번에 어디까지 봤는지"(scope)와 "끝까지 봤는지"(complete)를 남긴다.
 *    부분 수집 파일이 전체 스냅샷처럼 기존 데이터를 지우는 일을 막는다.
 *  - 잘못된 입력은 반영 전에 거부한다. 통과한 것만 원자적으로 반영한다(리뷰 R10).
 */
(function (root, factory) {
  const mod = factory(
    typeof require === "function" ? require("./urls.js") : root.JigguUrls,
    typeof require === "function" ? require("./brands.js") : root.JigguBrands,
    typeof require === "function" ? require("./money.js") : root.JigguMoney
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguSchema = mod;
})(typeof self !== "undefined" ? self : this, function (urls, brands, money) {
  "use strict";

  const SCHEMA_VERSION = 2;

  // 수집 결과 파일 한도 (설정 상수 — 초과 파일은 반영 전에 거부한다)
  const LIMITS = {
    MAX_FILE_BYTES: 20 * 1024 * 1024, // 20MiB
    MAX_OFFERS: 50000,
    MAX_IMAGES_PER_ITEM: 8,
  };

  // 판매처별 수집 상태. HTTP 상태와 실패 단계는 따로 남긴다.
  const SOURCE_STATUS = {
    OK: "ok",
    PARTIAL: "partial",
    EMPTY: "empty",
    UNSUPPORTED_ENDPOINT: "unsupported_endpoint",
    RENDER_REQUIRED: "render_required",
    PARSE_ERROR: "parse_error",
    TIMEOUT: "timeout",
    RATE_LIMITED: "rate_limited",
    BLOCKED: "blocked",
    ROBOTS_DISALLOWED: "robots_disallowed",
    UNVERIFIED: "unverified",
    // 위 분류에 안 들어가는 HTTP 오류(5xx 등). httpStatus에 실제 코드를 남긴다.
    HTTP_ERROR: "http_error",
  };
  const SOURCE_STATUS_VALUES = Object.keys(SOURCE_STATUS).map((k) => SOURCE_STATUS[k]);

  // 성공적으로 "그 범위를 끝까지 봤다"고 말할 수 있는 상태
  const COMPLETABLE_STATUSES = [SOURCE_STATUS.OK, SOURCE_STATUS.EMPTY];

  // 원가 계산까지 가능한 시장(국가) — 그 밖은 원문 가격만 보존한다
  const MARKET_COUNTRY_RE = /^[A-Z]{2}$/;

  const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

  /** 상품 키 — 이 값이 같으면 같은 상품/옵션이다 */
  function itemKey(item) {
    if (!item) return null;
    const src = item.sourceId || "unknown";
    const pid = item.productId || item.sourceUrl || item.id || "";
    const vid = item.variantId == null || item.variantId === "" ? "-" : item.variantId;
    if (!pid) return null;
    return `${src}::${pid}::${vid}`;
  }

  /** 수집 범위 키 — 완전 수집(complete)일 때만 이 범위 안의 삭제가 허용된다 */
  function scopeKey(sourceResult) {
    if (!sourceResult) return null;
    const scope = sourceResult.scope || {};
    return [
      sourceResult.sourceId || "unknown",
      scope.kind || "unknown",
      scope.value == null ? "" : String(scope.value),
    ].join("|");
  }

  /**
   * 상품 하나를 검증·정규화한다. 실패하면 {ok:false, error}.
   * 기존 필드명(brand/name/listPrice/salePrice/sizes/imageUrls/sourceShop/region…)은
   * 그대로 유지해 기존 화면이 계속 동작하게 한다.
   */
  function normalizeItem(raw, ctx) {
    const c = ctx || {};
    if (!raw || typeof raw !== "object") return { ok: false, error: "상품이 객체가 아님" };

    const name = String(raw.name || raw.title || "").trim();
    if (!name) return { ok: false, error: "상품명이 없음" };

    const currency = String(raw.currency || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: `통화 코드가 올바르지 않음: ${raw.currency}` };

    const salePrice = Number(raw.salePrice !== undefined ? raw.salePrice : raw.price);
    if (!isFiniteNum(salePrice) || salePrice <= 0) return { ok: false, error: `판매가가 올바르지 않음: ${raw.salePrice}` };

    let listPrice = Number(raw.listPrice);
    if (!isFiniteNum(listPrice) || listPrice <= salePrice) listPrice = salePrice;

    const sourceId = String(raw.sourceId || c.sourceId || "").trim();
    if (!sourceId) return { ok: false, error: "sourceId가 없음" };

    const marketCountry = String(raw.marketCountry || c.marketCountry || "").trim().toUpperCase();
    if (marketCountry && !MARKET_COUNTRY_RE.test(marketCountry)) {
      return { ok: false, error: `marketCountry가 ISO 2자리 국가코드가 아님: ${raw.marketCountry}` };
    }

    const sourceUrl = raw.sourceUrl ? urls.safeHref(raw.sourceUrl) : null;
    if (raw.sourceUrl && !sourceUrl) return { ok: false, error: `상품 URL이 올바르지 않음: ${raw.sourceUrl}` };

    const brandRaw = String(raw.brand || "").trim();
    const brandId = raw.brandId ? String(raw.brandId) : brands.toBrandId(brandRaw) || null;

    const region = String(raw.region || c.region || "").trim().toUpperCase() || null;

    const imageUrls = (Array.isArray(raw.imageUrls) ? raw.imageUrls : [])
      .map((u) => urls.safeImageUrl(u))
      .filter(Boolean)
      .slice(0, LIMITS.MAX_IMAGES_PER_ITEM);

    const availability = raw.availability || "unknown";
    const onSale = listPrice > salePrice;

    const item = {
      // --- 식별 ---
      sourceId,
      productId: raw.productId ? String(raw.productId) : sourceUrl || `${sourceId}:${name}`,
      variantId: raw.variantId == null ? null : String(raw.variantId),
      sku: raw.sku ? String(raw.sku) : null,
      scopeId: raw.scopeId ? String(raw.scopeId) : c.scopeId || null,
      // --- 브랜드/판매처 ---
      brandId,
      brand: brandRaw || (brandId ? brands.brandEnglish(brandId) : ""),
      sourceShop: String(raw.sourceShop || c.sourceShop || sourceId),
      marketCountry: marketCountry || null,
      locale: raw.locale ? String(raw.locale) : c.locale || null,
      region,
      // --- 가격 ---
      name,
      currency,
      salePrice,
      listPrice,
      onSale,
      offRate: onSale ? Math.round((1 - salePrice / listPrice) * 100) : 0,
      minPrice: isFiniteNum(raw.minPrice) ? raw.minPrice : salePrice,
      maxPrice: isFiniteNum(raw.maxPrice) ? raw.maxPrice : salePrice,
      priceVaries: !!raw.priceVaries,
      availability,
      // --- 부가 정보 ---
      category: raw.category ? String(raw.category) : "apparel",
      weightKg: isFiniteNum(raw.weightKg) && raw.weightKg > 0 ? raw.weightKg : 0.8,
      sizes: typeof raw.sizes === "string" ? raw.sizes : Array.isArray(raw.sizes) ? raw.sizes.join(" / ") : "",
      color: raw.color ? String(raw.color) : "",
      imageUrls,
      sourceUrl,
      collectedAt: raw.collectedAt || c.collectedAt || null,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String).slice(0, 10) : [],
    };

    item.id = item.key = itemKey(item);
    if (!item.key) return { ok: false, error: "상품 키를 만들 수 없음" };
    return { ok: true, item };
  }

  /** 판매처별 수집 결과 정규화 */
  function normalizeSourceResult(raw) {
    if (!raw || typeof raw !== "object") return null;
    const sourceId = String(raw.sourceId || "").trim();
    if (!sourceId) return null;
    const status = SOURCE_STATUS_VALUES.indexOf(raw.status) >= 0 ? raw.status : SOURCE_STATUS.UNVERIFIED;
    const scope = raw.scope && typeof raw.scope === "object" ? raw.scope : { kind: "unknown", value: null };
    const complete = raw.complete === true && COMPLETABLE_STATUSES.indexOf(status) >= 0;
    return {
      sourceId,
      sourceShop: raw.sourceShop ? String(raw.sourceShop) : sourceId,
      marketCountry: raw.marketCountry ? String(raw.marketCountry).toUpperCase() : null,
      scope: { kind: String(scope.kind || "unknown"), value: scope.value == null ? null : String(scope.value) },
      status,
      complete,
      nextCursor: raw.nextCursor == null ? null : String(raw.nextCursor),
      httpStatus: isFiniteNum(raw.httpStatus) ? raw.httpStatus : null,
      stage: raw.stage ? String(raw.stage) : null,
      discovered: isFiniteNum(raw.discovered) ? raw.discovered : 0,
      fetched: isFiniteNum(raw.fetched) ? raw.fetched : 0,
      accepted: isFiniteNum(raw.accepted) ? raw.accepted : 0,
      rejected: isFiniteNum(raw.rejected) ? raw.rejected : 0,
      pages: isFiniteNum(raw.pages) ? raw.pages : 0,
      retryAfter: raw.retryAfter == null ? null : String(raw.retryAfter),
      error: raw.error ? String(raw.error).slice(0, 500) : null,
      collectedAt: raw.collectedAt || null,
      listingUrl: raw.listingUrl ? String(raw.listingUrl) : null,
      // 기존 화면 호환 — 실패 목록 표시에 쓰던 필드
      brand: raw.brand ? String(raw.brand) : raw.sourceShop ? String(raw.sourceShop) : sourceId,
      domain: raw.domain ? String(raw.domain) : null,
    };
  }

  function makeSourceResult(source, patch) {
    const base = {
      sourceId: source && source.sourceId,
      sourceShop: source && (source.shopName || source.sourceShop),
      marketCountry: source && source.marketCountry,
      domain: source && source.domain,
      brand: source && (source.shopName || source.brand),
      scope: { kind: "listing", value: null },
      status: SOURCE_STATUS.UNVERIFIED,
      complete: false,
      collectedAt: new Date().toISOString(),
    };
    return normalizeSourceResult(Object.assign(base, patch || {}));
  }

  /**
   * 수집 결과 파일/응답 전체를 검증한다. 전부 파싱한 뒤에야 결과를 돌려주므로
   * 호출부는 성공했을 때만 상태에 반영하면 된다(원자적 import).
   * schemaVersion이 없는 구형 파일도 받아들이되 complete는 절대 true로 올리지 않는다.
   */
  function validateResult(input, opts) {
    const o = opts || {};
    const errors = [];
    const warnings = [];

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errors: ["JSON 최상위가 객체가 아닙니다"], warnings, result: null };
    }

    const rawItems = Array.isArray(input.items) ? input.items : null;
    if (!rawItems) return { ok: false, errors: ["items 배열이 없습니다"], warnings, result: null };
    if (!rawItems.length) return { ok: false, errors: ["items가 비어 있습니다"], warnings, result: null };
    if (rawItems.length > LIMITS.MAX_OFFERS) {
      return {
        ok: false,
        errors: [`상품이 너무 많습니다 (${rawItems.length} > ${LIMITS.MAX_OFFERS}). 수집 파일을 나눠서 가져오세요`],
        warnings,
        result: null,
      };
    }

    const version = isFiniteNum(input.schemaVersion) ? input.schemaVersion : 1;
    if (version > SCHEMA_VERSION) {
      return { ok: false, errors: [`이 앱이 모르는 형식입니다 (schemaVersion ${version})`], warnings, result: null };
    }
    const legacy = version < SCHEMA_VERSION;
    if (legacy) warnings.push("구형 수집 파일 — 수집 범위를 알 수 없어 추가(upsert)만 합니다");

    const collectedAt = input.collectedAt || input.scannedAt || new Date().toISOString();
    const runId = input.runId ? String(input.runId) : null;

    const sourceResults = [];
    (Array.isArray(input.sourceResults) ? input.sourceResults : []).forEach((sr) => {
      const norm = normalizeSourceResult(sr);
      if (norm) {
        if (legacy) norm.complete = false;
        sourceResults.push(norm);
      } else warnings.push("sourceResults 항목 하나를 읽지 못해 건너뜁니다");
    });

    const items = [];
    const seen = new Set();
    let rejected = 0;
    const rejectReasons = [];
    rawItems.forEach((raw, i) => {
      const fallbackSourceId =
        raw && raw.sourceId
          ? raw.sourceId
          : sourceResults.length === 1
          ? sourceResults[0].sourceId
          : raw && raw.sourceShop
          ? "legacy:" + String(raw.sourceShop)
          : o.defaultSourceId || null;
      const res = normalizeItem(raw, {
        sourceId: fallbackSourceId,
        collectedAt,
        sourceShop: raw && raw.sourceShop,
      });
      if (!res.ok) {
        rejected++;
        if (rejectReasons.length < 5) rejectReasons.push(`${i}번 상품: ${res.error}`);
        return;
      }
      if (seen.has(res.item.key)) return; // 같은 파일 안의 중복은 조용히 합친다
      seen.add(res.item.key);
      items.push(res.item);
    });

    if (!items.length) {
      return {
        ok: false,
        errors: ["쓸 수 있는 상품이 하나도 없습니다"].concat(rejectReasons),
        warnings,
        result: null,
      };
    }
    if (rejected) warnings.push(`${rejected}건은 형식이 맞지 않아 제외했습니다 (${rejectReasons[0] || ""})`);

    // sourceResults가 없으면 items에서 유추한다 — 단 complete는 false다
    if (!sourceResults.length) {
      const bySource = new Map();
      items.forEach((it) => {
        if (!bySource.has(it.sourceId)) bySource.set(it.sourceId, 0);
        bySource.set(it.sourceId, bySource.get(it.sourceId) + 1);
      });
      bySource.forEach((count, sourceId) => {
        sourceResults.push(
          normalizeSourceResult({
            sourceId,
            status: SOURCE_STATUS.PARTIAL,
            complete: false,
            accepted: count,
            scope: { kind: "unknown", value: null },
            collectedAt,
          })
        );
      });
      warnings.push("수집 범위 정보가 없어 기존 상품을 지우지 않고 추가만 합니다");
    }

    // 상품에 scopeId를 채워 넣는다 (완전 수집 범위 갱신 판단에 쓰인다)
    const scopeBySource = new Map();
    sourceResults.forEach((sr) => {
      if (!scopeBySource.has(sr.sourceId)) scopeBySource.set(sr.sourceId, scopeKey(sr));
    });
    items.forEach((it) => {
      if (!it.scopeId) it.scopeId = scopeBySource.get(it.sourceId) || null;
    });

    return {
      ok: true,
      errors,
      warnings,
      result: {
        schemaVersion: SCHEMA_VERSION,
        runId,
        collectedAt,
        mode: input.mode || null,
        fxRates: input.fxRates || null,
        fxSource: input.fxSource || null,
        fxAsOf: input.fxAsOf || null,
        sourceResults,
        items,
      },
    };
  }

  return {
    SCHEMA_VERSION,
    LIMITS,
    SOURCE_STATUS,
    SOURCE_STATUS_VALUES,
    COMPLETABLE_STATUSES,
    itemKey,
    scopeKey,
    normalizeItem,
    normalizeSourceResult,
    makeSourceResult,
    validateResult,
  };
});
