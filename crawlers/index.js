// 수집 어댑터 등록소
//
// 어댑터의 최소 역할 (계획 3.2)
//   discoverProducts({page, source, cursor, limit}) → 상품 URL·다음 위치·발견 완료 여부
//   fetchOffers({page, source, url})                → 같은 상품의 옵션별 Offer와 경고
//
// 새 판매처를 붙일 때는 config/targets.json의 adapter 이름만 여기 등록된 값으로 지정한다.

const generic = require("./generic-jsonld.js");
const rei = require("./rei-us.js");

const ADAPTERS = {
  "jsonld-browser": generic,
  "rei-us": rei,
};

function getAdapter(name) {
  return ADAPTERS[name] || null;
}

function adapterNames() {
  return Object.keys(ADAPTERS);
}

module.exports = { ADAPTERS, getAdapter, adapterNames };
