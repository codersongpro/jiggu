/* Offer(옵션별 판매 조건) 정규화 — 브라우저/Node 공용
 *
 * 예전 코드는 옵션 A의 최저 판매가와 옵션 B의 최고 정가를 조합했다(리뷰 R04).
 * 50/100달러 옵션과 80/200달러 옵션이 있으면 "50 → 200, 75% 할인"이라는 실제로
 * 존재하지 않는 할인이 만들어진다. 가격·정가·재고·사이즈·색상·SKU는 반드시
 * 같은 Offer(=같은 variant) 안에서만 조합한다.
 *
 * AggregateOffer의 lowPrice/highPrice는 "옵션별 가격 범위"지 할인 근거가 아니다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguOffers = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const AVAILABILITY = { IN_STOCK: "in_stock", OUT_OF_STOCK: "out_of_stock", UNKNOWN: "unknown" };

  const IN_STOCK_RE = /(^|\/)(instock|in_stock|available|limitedavailability|onlineonly|instoreonly|presale|preorder|backorder)$/;
  const OUT_RE = /(^|\/)(outofstock|out_of_stock|soldout|discontinued|unavailable)$/;

  /** schema.org / 피드 / Shopify의 재고 표기를 3가지 상태로 정리한다. */
  function normalizeAvailability(raw) {
    if (raw === true) return AVAILABILITY.IN_STOCK;
    if (raw === false) return AVAILABILITY.OUT_OF_STOCK;
    if (raw === undefined || raw === null || raw === "") return AVAILABILITY.UNKNOWN;

    if (typeof raw === "number") return raw > 0 ? AVAILABILITY.IN_STOCK : AVAILABILITY.OUT_OF_STOCK;

    const s = String(raw).trim().toLowerCase();
    if (!s) return AVAILABILITY.UNKNOWN;
    // "10", "0" 같은 재고 수량. 0만 품절이고 10은 재고 있음이다(리뷰 R06 — 예전엔 '0'이
    // 포함된다는 이유로 10도 품절 처리됐다).
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s) > 0 ? AVAILABILITY.IN_STOCK : AVAILABILITY.OUT_OF_STOCK;

    const key = s.replace(/^https?:\/\/schema\.org\//, "/").replace(/[\s_-]/g, "");
    if (OUT_RE.test(key)) return AVAILABILITY.OUT_OF_STOCK;
    if (IN_STOCK_RE.test(key)) return AVAILABILITY.IN_STOCK;
    if (key === "yes" || key === "true" || key === "y") return AVAILABILITY.IN_STOCK;
    if (key === "no" || key === "false" || key === "n") return AVAILABILITY.OUT_OF_STOCK;
    return AVAILABILITY.UNKNOWN;
  }

  /**
   * Offer 하나를 정규화한다. 필드는 전부 같은 옵션에서 와야 한다.
   * @param {{price:number, compareAtPrice?:number, currency?:string, availability?:*,
   *          size?:string, color?:string, sku?:string, variantId?:*, url?:string,
   *          priceRange?:boolean, minPrice?:number, maxPrice?:number}} raw
   */
  function normalizeOffer(raw) {
    if (!raw || typeof raw !== "object") return null;
    const price = Number(raw.price);
    const warnings = Array.isArray(raw.warnings) ? raw.warnings.slice() : [];

    const offer = {
      variantId: raw.variantId === undefined || raw.variantId === null ? null : String(raw.variantId),
      sku: raw.sku ? String(raw.sku) : null,
      price: Number.isFinite(price) && price > 0 ? price : null,
      compareAtPrice: null,
      currency: raw.currency ? String(raw.currency).toUpperCase() : null,
      availability: normalizeAvailability(raw.availability),
      size: raw.size ? String(raw.size) : null,
      color: raw.color ? String(raw.color) : null,
      url: raw.url ? String(raw.url) : null,
      // AggregateOffer처럼 "가격 범위"만 아는 경우 — 할인 근거로 쓰지 않는다
      priceRange: raw.priceRange === true ? { min: Number(raw.minPrice), max: Number(raw.maxPrice) } : null,
      warnings,
    };

    const compare = Number(raw.compareAtPrice);
    // 정가는 같은 옵션의 판매가보다 클 때만 유효하다
    if (Number.isFinite(compare) && offer.price !== null && compare > offer.price) offer.compareAtPrice = compare;
    else if (Number.isFinite(compare) && offer.price !== null && compare > 0 && compare < offer.price) {
      warnings.push("정가가 판매가보다 낮음 — 할인 계산에서 제외");
    }

    if (offer.price === null && !offer.priceRange) return null;
    return offer;
  }

  function normalizeOffers(list) {
    return (Array.isArray(list) ? list : [list])
      .map(normalizeOffer)
      .filter(Boolean);
  }

  /**
   * 상품 카드/상세에 쓸 가격 요약. 재고가 확인된 옵션만 최저가 후보로 삼는다.
   * @returns {{
   *   currency:string|null, salePrice:number|null, listPrice:number|null,
   *   onSale:boolean, offRate:number, minPrice:number|null, maxPrice:number|null,
   *   priceVaries:boolean, availability:string, selectedOffer:object|null,
   *   offerCount:number, warnings:string[]
   * }}
   */
  function summarizeOffers(offers) {
    const list = normalizeOffers(offers || []);
    const warnings = [];
    const currencies = [...new Set(list.map((o) => o.currency).filter(Boolean))];
    if (currencies.length > 1) warnings.push(`한 상품에 통화가 여러 개(${currencies.join(", ")}) — 첫 통화 기준으로 표시`);

    const priced = list.filter((o) => o.price !== null);
    const inStock = priced.filter((o) => o.availability === AVAILABILITY.IN_STOCK);
    const unknown = priced.filter((o) => o.availability === AVAILABILITY.UNKNOWN);

    let basis;
    let availability;
    if (inStock.length) {
      basis = inStock;
      availability = AVAILABILITY.IN_STOCK;
    } else if (unknown.length) {
      // 재고를 확인하지 못한 옵션은 "구매 가능한 최저가"로 섞지 않고 따로 표시한다
      basis = unknown;
      availability = AVAILABILITY.UNKNOWN;
    } else if (priced.length) {
      basis = priced;
      availability = AVAILABILITY.OUT_OF_STOCK;
    } else {
      const range = list.find((o) => o.priceRange);
      if (range && Number.isFinite(range.priceRange.min)) {
        return {
          currency: range.currency || currencies[0] || null,
          salePrice: range.priceRange.min,
          listPrice: null,
          onSale: false,
          offRate: 0,
          minPrice: range.priceRange.min,
          maxPrice: Number.isFinite(range.priceRange.max) ? range.priceRange.max : range.priceRange.min,
          priceVaries: Number.isFinite(range.priceRange.max) && range.priceRange.max > range.priceRange.min,
          availability: AVAILABILITY.UNKNOWN,
          selectedOffer: null,
          offerCount: list.length,
          warnings: warnings.concat("가격 범위만 확인됨(AggregateOffer) — 옵션별 가격·할인 미확인"),
        };
      }
      return {
        currency: currencies[0] || null,
        salePrice: null, listPrice: null, onSale: false, offRate: 0,
        minPrice: null, maxPrice: null, priceVaries: false,
        availability: AVAILABILITY.UNKNOWN, selectedOffer: null, offerCount: 0,
        warnings: warnings.concat("가격을 확인하지 못함"),
      };
    }

    // 최저가 옵션을 하나 고르고, 그 옵션의 값만 사용한다
    const selected = basis.reduce((a, b) => (b.price < a.price ? b : a));
    const min = Math.min(...basis.map((o) => o.price));
    const max = Math.max(...basis.map((o) => o.price));

    const listPrice = selected.compareAtPrice; // 같은 옵션의 정가만
    const onSale = !!listPrice && listPrice > selected.price;

    return {
      currency: selected.currency || currencies[0] || null,
      salePrice: selected.price,
      listPrice: onSale ? listPrice : null,
      onSale,
      offRate: onSale ? Math.round((1 - selected.price / listPrice) * 100) : 0,
      minPrice: min,
      maxPrice: max,
      priceVaries: max > min,
      availability,
      selectedOffer: selected,
      offerCount: list.length,
      warnings,
    };
  }

  /** 재고가 확인된 옵션의 사이즈 목록 (품절 사이즈를 판매 가능한 것처럼 보여주지 않는다) */
  function availableSizes(offers) {
    const list = normalizeOffers(offers || []);
    const pool = list.filter((o) => o.availability === AVAILABILITY.IN_STOCK);
    const use = pool.length ? pool : list.filter((o) => o.availability === AVAILABILITY.UNKNOWN);
    return [...new Set(use.map((o) => o.size).filter(Boolean))];
  }

  return { AVAILABILITY, normalizeAvailability, normalizeOffer, normalizeOffers, summarizeOffers, availableSizes };
});
