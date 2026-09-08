/* 랜딩코스트(최종원가) 계산기 — 브라우저/Node 공용 순수 함수
 *
 * 예전에는 서버(api/_lib/landedCost.js)와 브라우저(web/index.html)에 계산이 따로
 * 있었고 값도 달랐다(리뷰 R12 — 브라우저에는 10kg 구간이 없고 초과 요금이 지역
 * 구분 없이 11,000원 고정이라 6kg 상품의 배송비가 서버와 달랐다).
 * 이제 계산은 여기 한 곳에만 있고, 설정은 config/cost.yaml → (서버는 직접,
 * 브라우저는 GET /api/config) 같은 원본에서 주입한다. 숫자를 코드에 넣지 않는다.
 *
 * 시장(국가)과 원가 프로필은 다르다.
 *  - marketCountry: 실제 쇼핑 시장 (US/JP/GB/DE/FR/IT/ES/NL …)
 *  - costProfile  : 세금·배대지 요율을 아는 구간 (US/EU/JP)
 * 조건이 검증되지 않은 시장(예: GB)은 원문 가격만 보존하고 status:"incomplete"를
 * 돌려준다. 영국을 EU 규칙에 몰래 넣지 않는다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguCost = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * 시장(국가) → {currency, costProfile, vatRate, supported}
   * cost.yaml의 markets 섹션을 본다. 없으면 기존 region 값을 그대로 프로필로 쓴다.
   */
  function resolveMarket(cfg, marketCountryOrRegion) {
    const key = String(marketCountryOrRegion || "").toUpperCase();
    const markets = (cfg && cfg.markets) || {};
    if (markets[key]) {
      const m = markets[key];
      return {
        marketCountry: key,
        currency: m.currency || null,
        costProfile: m.cost_profile || null,
        vatRate: typeof m.vat_rate === "number" ? m.vat_rate : null,
        supported: !!m.cost_profile,
        note: m.note || null,
      };
    }
    // 구형 데이터 호환 — region(US/EU/JP)이 그대로 들어오는 경우
    if (cfg && cfg.local_tax && cfg.local_tax[key]) {
      return { marketCountry: key, currency: null, costProfile: key, vatRate: null, supported: true, note: null };
    }
    return {
      marketCountry: key || null,
      currency: null,
      costProfile: null,
      vatRate: null,
      supported: false,
      note: "등록되지 않은 시장 — 세금·배송 조건 미검증",
    };
  }

  /** 실질환율 = 매매기준율 * (1 + 카드수수료) */
  function fxRate(cfg, currency) {
    const base = cfg.fx.base_rate[String(currency || "").toUpperCase()];
    if (!(base > 0)) return null;
    return base * (1 + cfg.fx.card_fee_rate);
  }

  /** 현지 실결제액 — EU/JP 표시가의 부가세 차감, US 판매세 가산 */
  function netLocalPrice(cfg, item, market) {
    const notes = [];
    const profile = market.costProfile;
    const taxCfg = cfg.local_tax[profile];
    let price = item.price - (item.discount || 0);

    if (profile === "US") {
      const rate = taxCfg.sales_tax_rate;
      if (rate > 0) {
        price *= 1 + rate;
        notes.push(`미국 판매세 ${(rate * 100).toFixed(1)}% 가산`);
      } else {
        notes.push("면세 州 배대지 기준(판매세 0)");
      }
    } else {
      // 국가별 VAT가 등록돼 있으면 그 값을 쓴다 (독일 19 / 프랑스 20 / 이탈리아 22 …)
      const rate = market.vatRate != null ? market.vatRate : taxCfg.vat_rate;
      if (taxCfg.price_includes_tax) {
        price /= 1 + rate;
        notes.push(`${market.marketCountry || profile} 부가세 ${Math.round(rate * 100)}% 차감(수출 면세)`);
      } else {
        notes.push(`${market.marketCountry || profile} 표시가가 세금 별도 기준`);
      }
    }
    return { localPrice: price + (item.local_shipping || 0), notes };
  }

  /** 배대지 국제배송비 (무게 구간표 + 최대 구간 초과분) */
  function intlShippingKrw(cfg, weightKg, costProfile) {
    const rates = cfg.shipping.rates_krw[costProfile];
    if (!rates) return null;
    const handling = cfg.shipping.handling_fee_krw;
    const limits = Object.keys(rates)
      .map(Number)
      .sort((a, b) => a - b);
    for (const limit of limits) {
      if (weightKg <= limit) return Math.trunc(rates[limit] + handling);
    }
    const maxLimit = limits[limits.length - 1];
    const extra = (weightKg - maxLimit) * cfg.shipping.over_max_per_kg_krw[costProfile];
    return Math.trunc(rates[maxLimit] + extra + handling);
  }

  /** 관·부가세. proxy는 면세한도 적용, business는 없음(초과 시 전체 금액 과세) */
  function customs(cfg, dutiableKrw, item, market, mode) {
    const c = cfg.customs;
    const notes = [];
    const usdRate = cfg.fx.base_rate.USD;
    const dutiableUsd = dutiableKrw / usdRate;

    if (mode === "proxy") {
      const limit = c.personal_exemption_usd[market.costProfile];
      if (dutiableUsd <= limit) {
        notes.push(`면세 적용(과세가격 $${Math.round(dutiableUsd)} ≤ $${limit})`);
        return { duty: 0, vat: 0, dutiableUsd, taxFree: true, notes };
      }
      notes.push(`면세한도 초과($${Math.round(dutiableUsd)} > $${limit}) → 전체 금액 과세`);
    } else {
      notes.push("사업자 통관 — 면세한도 없음");
    }

    const dutyRate = c.duty_rates[item.category] != null ? c.duty_rates[item.category] : c.duty_rates.default;
    const duty = Math.trunc(dutiableKrw * dutyRate);
    const vat = Math.trunc((dutiableKrw + duty) * c.vat_rate);
    notes.push(`관세 ${Math.round(dutyRate * 100)}% + 부가세 ${Math.round(c.vat_rate * 100)}%`);
    return { duty, vat, dutiableUsd, taxFree: false, notes };
  }

  /**
   * @param {object} cfg  cost.yaml (또는 /api/config) 내용
   * @param {{price:number, currency:string, marketCountry?:string, region?:string,
   *          category:string, weight_kg:number}} item
   * @param {"proxy"|"business"} mode
   * @param {boolean} vatDeductible 사업자 매입세액공제 가정
   * @returns {{status:"ok"|"incomplete", incompleteReason?:string, ...}}
   */
  function landedCost(cfg, item, mode, vatDeductible) {
    const m = mode === "business" ? "business" : "proxy";
    const market = resolveMarket(cfg, item.marketCountry || item.region);

    const rate = fxRate(cfg, item.currency);
    if (!market.supported || !market.costProfile || rate === null) {
      // 조건을 모르면 원문 가격은 그대로 두고 총원가는 계산하지 않는다
      return {
        status: "incomplete",
        incompleteReason: !market.supported
          ? `${market.marketCountry || "?"} 시장의 세금·배대지 조건이 검증되지 않아 원가를 계산하지 않습니다`
          : `${item.currency} 환율이 등록되지 않아 원가를 계산하지 않습니다`,
        marketCountry: market.marketCountry,
        costProfile: market.costProfile,
        itemKrw: null, intlShippingKrw: null, dutyKrw: null, importVatKrw: null,
        clearanceFeeKrw: null, totalKrw: null, dutiableUsd: null, taxFree: false,
        notes: [market.note || "원가 계산 미완료"],
      };
    }

    const { localPrice, notes } = netLocalPrice(cfg, item, market);
    const itemKrw = localPrice * rate;
    const shipKrw = intlShippingKrw(cfg, item.weight_kg, market.costProfile);
    const dutiable = itemKrw + (cfg.customs.include_shipping_in_dutiable ? shipKrw : 0);
    const { duty, vat, dutiableUsd, taxFree, notes: cnotes } = customs(cfg, dutiable, item, market, m);

    const clearance = m === "business" ? cfg.customs.clearance_fee_krw : 0;
    const countedVat = vatDeductible && m === "business" ? 0 : vat;
    if (vatDeductible && m === "business") cnotes.push("부가세 매입세액공제 가정 → 원가에서 제외");

    const total = itemKrw + shipKrw + duty + countedVat + clearance;

    return {
      status: "ok",
      marketCountry: market.marketCountry,
      costProfile: market.costProfile,
      itemKrw: Math.trunc(itemKrw),
      intlShippingKrw: shipKrw,
      dutyKrw: duty,
      importVatKrw: countedVat,
      clearanceFeeKrw: clearance,
      totalKrw: Math.trunc(total),
      dutiableUsd: Math.round(dutiableUsd * 10) / 10,
      taxFree,
      fxAsOf: (cfg.fx && cfg.fx.as_of) || (cfg.meta && cfg.meta.last_verified) || null,
      fxSource: (cfg.fx && cfg.fx.source) || "config/cost.yaml",
      notes: notes.concat(cnotes),
    };
  }

  /** 마진 계산 (판매 채널 수수료 반영) */
  function margin(cfg, cost, salePriceKrw, channel) {
    const s = cfg.sales;
    const feeRate = s.channel_fee_rate[channel || "smartstore"];
    const fee = salePriceKrw * feeRate;
    const other = s.domestic_shipping_krw + s.packaging_krw + cost.totalKrw * s.return_rate;
    const profit = salePriceKrw - fee - other - cost.totalKrw;
    const breakeven = (cost.totalKrw + other) / (1 - feeRate);
    return {
      salePriceKrw: Math.trunc(salePriceKrw),
      channelFeeKrw: Math.trunc(fee),
      otherCostKrw: Math.trunc(other),
      costKrw: cost.totalKrw,
      profitKrw: Math.trunc(profit),
      marginRate: salePriceKrw ? Math.round((profit / salePriceKrw) * 10000) / 10000 : 0,
      breakevenKrw: Math.trunc(breakeven),
    };
  }

  return { resolveMarket, fxRate, netLocalPrice, intlShippingKrw, customs, landedCost, margin };
});
