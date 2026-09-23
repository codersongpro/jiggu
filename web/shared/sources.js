/* 판매처(소스) 정본 목록 로더 — 브라우저/Node 공용
 *
 * config/targets.json 하나가 서버 스캔·PC 크롤러·웹의 필터에 공통으로 쓰인다.
 * (예전에는 서버용 targets.json과 PC용 sites.json이 따로 있어 같은 판매처가
 *  두 번 등록돼 있었다 — 리뷰 T01.)
 *
 * 판매처(sourceId)와 브랜드(brandId)는 다르다. REI 한 곳을 수집하면 Patagonia·
 * Arc'teryx 등 여러 브랜드가 나온다. 편집숍의 brand 필드는 구입처 이름일 뿐이다.
 */
(function (root, factory) {
  const mod = factory(
    typeof require === "function" ? require("./brands.js") : root.JigguBrands,
    typeof require === "function" ? require("./urls.js") : root.JigguUrls
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguSources = mod;
})(typeof self !== "undefined" ? self : this, function (brands, urls) {
  "use strict";

  const RUNTIME = { SERVER: "server", PC: "pc", FEED: "feed" };
  const KIND = { OFFICIAL: "official", MULTI_BRAND: "multi_brand" };
  const SUPPORT = { SUPPORTED: "supported", UNVERIFIED: "unverified", BLOCKED: "blocked", DISABLED: "disabled" };

  function normalizeSource(raw, index) {
    if (!raw || typeof raw !== "object") return { error: `${index}번 항목이 객체가 아님` };
    const sourceId = String(raw.sourceId || "").trim();
    if (!sourceId) return { error: `${index}번 항목에 sourceId가 없음` };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sourceId)) return { error: `sourceId 형식이 올바르지 않음: ${sourceId}` };

    const domain = String(raw.domain || "").trim().toLowerCase();
    const baseUrl = raw.baseUrl || (domain ? `https://${domain}` : "");
    if (!baseUrl || !urls.isPublicHttpUrl(baseUrl)) return { error: `${sourceId}: baseUrl이 올바르지 않음` };

    const allowedHosts = (Array.isArray(raw.allowedHosts) && raw.allowedHosts.length
      ? raw.allowedHosts
      : [domain || urls.parseUrl(baseUrl).hostname]
    )
      .map((h) => String(h).toLowerCase())
      .filter(Boolean);

    const kind = raw.kind === KIND.MULTI_BRAND ? KIND.MULTI_BRAND : KIND.OFFICIAL;
    const brandId = kind === KIND.OFFICIAL ? raw.brandId || brands.toBrandId(raw.shopName) : null;

    const support = raw.support && typeof raw.support === "object" ? raw.support : {};
    const status = Object.keys(SUPPORT).map((k) => SUPPORT[k]).indexOf(support.status) >= 0
      ? support.status
      : SUPPORT.UNVERIFIED;

    return {
      source: {
        sourceId,
        shopName: String(raw.shopName || sourceId),
        shopName_kr: raw.shopName_kr || raw.shopName || sourceId,
        kind,
        brandId,
        marketCountry: String(raw.marketCountry || "").toUpperCase() || null,
        locale: raw.locale || null,
        currency: String(raw.currency || "").toUpperCase() || null,
        region: String(raw.region || "").toUpperCase() || null, // 원가 프로필(US/EU/JP)
        baseUrl: baseUrl.replace(/\/$/, ""),
        domain: domain || urls.parseUrl(baseUrl).hostname,
        allowedHosts,
        adapter: String(raw.adapter || "shopify-products-json"),
        runtime: raw.runtime === RUNTIME.PC ? RUNTIME.PC : raw.runtime === RUNTIME.FEED ? RUNTIME.FEED : RUNTIME.SERVER,
        listingUrls: Array.isArray(raw.listingUrls) ? raw.listingUrls.filter((u) => urls.isPublicHttpUrl(u)) : [],
        sitemapUrl: raw.sitemapUrl && urls.isPublicHttpUrl(raw.sitemapUrl) ? raw.sitemapUrl : null,
        productIdPattern: raw.productIdPattern || null,
        productLinkPattern: raw.productLinkPattern || null,
        readySelector: raw.readySelector || null,
        nextPageSelector: raw.nextPageSelector || null,
        category: raw.category || "apparel",
        popular: raw.popular === true,
        // Shopify 세일 컬렉션 핸들(예: "sale", "mens-sale"). URL 경로 조각이라 안전한 문자만 받는다
        saleCollections: Array.isArray(raw.saleCollections)
          ? raw.saleCollections.map(String).filter((h) => /^[a-z0-9][a-z0-9-]{0,60}$/i.test(h))
          : [],
        support: {
          status,
          checkedAt: support.checkedAt || null,
          environment: support.environment || null,
          error: support.error || null,
          note: support.note || null,
        },
      },
    };
  }

  /**
   * targets.json → 검증된 소스 목록.
   * @returns {{sources:Array, errors:string[], warnings:string[]}}
   */
  function loadSources(config) {
    const errors = [];
    const warnings = [];
    const list = config && Array.isArray(config.sources) ? config.sources : null;
    if (!list) return { sources: [], errors: ["targets.json에 sources 배열이 없습니다"], warnings };

    const sources = [];
    const seen = new Map();
    list.forEach((raw, i) => {
      const res = normalizeSource(raw, i);
      if (res.error) {
        errors.push(res.error);
        return;
      }
      const s = res.source;
      if (seen.has(s.sourceId)) {
        errors.push(`sourceId 중복: ${s.sourceId}`);
        return;
      }
      // 같은 판매처/시장이 두 번 등록되는 것도 막는다 (targets.json + sites.json 통합 시 발생)
      const marketKey = `${s.domain}|${s.marketCountry || ""}`;
      if (seen.has(marketKey)) {
        warnings.push(`같은 도메인·시장이 중복 등록됨: ${s.domain} (${s.sourceId} / ${seen.get(marketKey)})`);
      }
      seen.set(s.sourceId, s.sourceId);
      seen.set(marketKey, s.sourceId);
      sources.push(s);
    });
    return { sources, errors, warnings };
  }

  const isBlocked = (s) => s.support.status === SUPPORT.BLOCKED || s.support.status === SUPPORT.DISABLED;

  /**
   * 조회 대상 판매처를 고른다. 브랜드를 지정하면 그 브랜드의 공식몰과
   * 편집숍(vendor로 섞여 나올 수 있다)만 고른다 — 예전처럼 전체를 훑지 않는다(리뷰 R02).
   * 반환 목록에는 같은 sourceId가 두 번 들어가지 않는다.
   */
  function selectSources(sources, opts) {
    const o = opts || {};
    let list = sources.filter((s) => !isBlocked(s));

    if (o.runtime) list = list.filter((s) => s.runtime === o.runtime);
    if (o.adapters && o.adapters.length) list = list.filter((s) => o.adapters.indexOf(s.adapter) >= 0);

    if (o.sourceIds && o.sourceIds.length) {
      const want = new Set(o.sourceIds.map(String));
      list = list.filter((s) => want.has(s.sourceId));
    }

    if (o.marketCountries && o.marketCountries.length) {
      const want = new Set(o.marketCountries.map((c) => String(c).toUpperCase()));
      list = list.filter((s) => s.marketCountry && want.has(s.marketCountry));
    }

    if (o.brandId) {
      const brandId = brands.canonicalBrandId(o.brandId) || String(o.brandId).toLowerCase();
      list = list.filter((s) => (s.kind === KIND.OFFICIAL ? s.brandId === brandId : true));
    } else if (o.onlyPopular) {
      list = list.filter((s) => s.popular);
    }

    // sourceId 기준 중복 제거 (같은 소스를 두 번 요청하지 않는다)
    const out = [];
    const seen = new Set();
    list.forEach((s) => {
      if (seen.has(s.sourceId)) return;
      seen.add(s.sourceId);
      out.push(s);
    });
    return out;
  }

  function findSource(sources, sourceId) {
    return sources.find((s) => s.sourceId === sourceId) || null;
  }

  /** 화면 필터용 — 시장(국가) 목록 */
  function marketCountries(sources) {
    return [...new Set(sources.map((s) => s.marketCountry).filter(Boolean))].sort();
  }

  return { RUNTIME, KIND, SUPPORT, loadSources, selectSources, findSource, marketCountries, isBlocked };
});
