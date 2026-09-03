// 해외의류 소싱 크롤러 - 랜딩코스트(최종원가) 계산 엔진 (Node.js 포팅)
//
// core/landed_cost.py 와 완전히 동일한 로직이다. 숫자는 여기 넣지 않는다 — config/cost.yaml만 본다.
// 통관 모드 2가지
//   proxy    : 구매대행. 고객 명의 개인통관 → 면세한도(US $200 / 그 외 $150) 적용
//   business : 사업자 사입. 면세한도 없음. 관세+부가세 전액 부과(부가세는 매입공제 옵션)

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function loadConfig(configPath) {
  const resolved = configPath || path.join(__dirname, "..", "..", "config", "cost.yaml");
  const raw = fs.readFileSync(resolved, "utf-8");
  return yaml.load(raw);
}

// ---------- 환율 ----------
// 실질환율 = 매매기준율 * (1 + 카드수수료)
function fxRate(cfg, currency) {
  const base = cfg.fx.base_rate[currency];
  return base * (1 + cfg.fx.card_fee_rate);
}

// ---------- 1) 현지 실결제액 ----------
// EU/JP 표시가는 부가세 포함이므로 한국 배송 시 차감된다. 이걸 빼면 원가가 20% 틀어진다.
// US는 배대지 州의 sales tax가 가산된다.
function netLocalPrice(cfg, item) {
  const notes = [];
  const taxCfg = cfg.local_tax[item.region];
  let price = item.price - (item.discount || 0);

  if (item.region === "US") {
    const rate = taxCfg.sales_tax_rate;
    if (rate > 0) {
      price *= 1 + rate;
      notes.push(`미국 판매세 ${(rate * 100).toFixed(1)}% 가산`);
    } else {
      notes.push("면세 州 배대지 기준(판매세 0)");
    }
  } else {
    const rate = taxCfg.vat_rate;
    if (taxCfg.price_includes_tax) {
      price /= 1 + rate;
      notes.push(`${item.region} 부가세 ${Math.round(rate * 100)}% 차감(수출 면세)`);
    } else {
      notes.push(`${item.region} 표시가가 세금 별도 기준`);
    }
  }

  return { localPrice: price + (item.local_shipping || 0), notes };
}

// ---------- 2) 국제배송비 ----------
function intlShippingKrw(cfg, weightKg, region) {
  const rates = cfg.shipping.rates_krw[region];
  const handling = cfg.shipping.handling_fee_krw;
  const limits = Object.keys(rates).map(Number).sort((a, b) => a - b);
  for (const limit of limits) {
    if (weightKg <= limit) return Math.trunc(rates[limit] + handling);
  }
  const maxLimit = limits[limits.length - 1];
  const extra = (weightKg - maxLimit) * cfg.shipping.over_max_per_kg_krw[region];
  return Math.trunc(rates[maxLimit] + extra + handling);
}

// ---------- 3) 관부가세 ----------
function customs(cfg, dutiableKrw, item, mode) {
  const c = cfg.customs;
  const notes = [];
  const usdRate = cfg.fx.base_rate.USD;
  const dutiableUsd = dutiableKrw / usdRate;

  if (mode === "proxy") {
    const limit = c.personal_exemption_usd[item.region];
    if (dutiableUsd <= limit) {
      notes.push(`면세 적용(과세가격 $${Math.round(dutiableUsd)} ≤ $${limit})`);
      return { duty: 0, vat: 0, dutiableUsd, taxFree: true, notes };
    }
    notes.push(`면세한도 초과($${Math.round(dutiableUsd)} > $${limit}) → 전체 금액 과세`);
  }

  const dutyRate = c.duty_rates[item.category] ?? c.duty_rates.default;
  const duty = Math.trunc(dutiableKrw * dutyRate);
  const vat = Math.trunc((dutiableKrw + duty) * c.vat_rate);
  notes.push(`관세 ${Math.round(dutyRate * 100)}% + 부가세 ${Math.round(c.vat_rate * 100)}%`);
  return { duty, vat, dutiableUsd, taxFree: false, notes };
}

// ---------- 통합 ----------
// vatDeductible: 사업자로서 수입 부가세를 매입세액공제 받는 경우 true → 실질 원가에서 부가세를 제외한다.
function landedCost(cfg, item, mode = "proxy", vatDeductible = false) {
  const { localPrice, notes } = netLocalPrice(cfg, item);
  const itemKrw = localPrice * fxRate(cfg, item.currency);
  const shipKrw = intlShippingKrw(cfg, item.weight_kg, item.region);

  const dutiable = itemKrw + (cfg.customs.include_shipping_in_dutiable ? shipKrw : 0);
  const { duty, vat, dutiableUsd, taxFree, notes: cnotes } = customs(cfg, dutiable, item, mode);

  const clearance = mode === "business" ? cfg.customs.clearance_fee_krw : 0;
  const countedVat = vatDeductible && mode === "business" ? 0 : vat;
  if (vatDeductible && mode === "business") {
    cnotes.push("부가세 매입세액공제 가정 → 원가에서 제외");
  }

  const total = itemKrw + shipKrw + duty + countedVat + clearance;

  return {
    itemKrw: Math.trunc(itemKrw),
    intlShippingKrw: shipKrw,
    dutyKrw: duty,
    importVatKrw: countedVat,
    clearanceFeeKrw: clearance,
    totalKrw: Math.trunc(total),
    dutiableUsd: Math.round(dutiableUsd * 10) / 10,
    taxFree,
    notes: notes.concat(cnotes),
  };
}

// ---------- 마진 ----------
function margin(cfg, cost, salePriceKrw, channel = "smartstore") {
  const s = cfg.sales;
  const feeRate = s.channel_fee_rate[channel];
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

module.exports = { loadConfig, fxRate, landedCost, margin, intlShippingKrw };
