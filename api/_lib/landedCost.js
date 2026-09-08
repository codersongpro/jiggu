// 랜딩코스트(최종원가) 계산 — 서버 전용 래퍼
//
// 계산 로직 자체는 web/shared/cost.js 하나에만 있다. 서버와 브라우저가 각각
// 계산을 들고 있으면 같은 상품의 원가가 화면과 서버에서 달라진다(리뷰 R12).
// 여기서는 config/cost.yaml을 읽어 넣어주는 일만 한다. 숫자는 코드에 넣지 않는다.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const cost = require("../../web/shared/cost.js");

function loadConfig(configPath) {
  const resolved = configPath || path.join(__dirname, "..", "..", "config", "cost.yaml");
  const raw = fs.readFileSync(resolved, "utf-8");
  return yaml.load(raw);
}

/** 브라우저에 내려보내도 되는 계산 설정만 골라낸다 (비밀값 없음) */
function publicConfig(cfg) {
  const c = cfg || loadConfig();
  return {
    meta: c.meta || null,
    fx: c.fx,
    markets: c.markets || {},
    local_tax: c.local_tax,
    shipping: c.shipping,
    customs: c.customs,
    sales: c.sales,
  };
}

module.exports = {
  loadConfig,
  publicConfig,
  fxRate: cost.fxRate,
  landedCost: (cfg, item, mode, vatDeductible) => cost.landedCost(cfg, item, mode || "proxy", !!vatDeductible),
  margin: (cfg, c, salePriceKrw, channel) => cost.margin(cfg, c, salePriceKrw, channel || "smartstore"),
  intlShippingKrw: cost.intlShippingKrw,
  resolveMarket: cost.resolveMarket,
};
