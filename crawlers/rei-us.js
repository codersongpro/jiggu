// REI(미국) 전용 어댑터 — 계획 4.2
//
// 공통 JSON-LD 어댑터를 그대로 쓰되 REI에서 확인해야 하는 것만 덧붙인다.
//  - 시작 URL은 공개 카테고리(https://www.rei.com/c/clothing). robots.txt가 /search와
//    일부 필터 쿼리를 제한하므로 그 경로에 의존하지 않는다.
//  - 상품 링크는 /product/<숫자>/... 형태다. 상대·절대 URL을 같은 상품 ID로 모은다.
//  - 목록이 "더 보기" 방식이면 rel=next가 없을 수 있어 page 파라미터로 진행한다.
//  - REI는 한 사이트에서 여러 브랜드를 판다. 상품의 brand를 그대로 쓰고
//    판매처 이름(REI)을 브랜드로 쓰지 않는다.

const generic = require("./generic-jsonld.js");
const links = require("./links.js");
const urls = require("../web/shared/urls.js");

const PRODUCT_ID_PATTERN = "^/product/(\\d+)/";
const PRODUCT_LINK_PATTERN = "^/product/\\d+/";

/** REI 목록 URL에 페이지 파라미터를 붙인다 (?page=2) */
function withPage(listingUrl, pageNo) {
  const u = urls.parseUrl(listingUrl);
  if (!u) return listingUrl;
  if (pageNo > 1) u.searchParams.set("page", String(pageNo));
  return u.toString();
}

function reiSource(source) {
  // 설정에 없더라도 REI의 상품 URL 규칙은 고정이다
  return Object.assign({}, source, {
    productIdPattern: source.productIdPattern || PRODUCT_ID_PATTERN,
    productLinkPattern: source.productLinkPattern || PRODUCT_LINK_PATTERN,
    readySelector: source.readySelector || 'a[href*="/product/"]',
  });
}

async function discoverProducts(ctx) {
  const source = reiSource(ctx.source);
  const cursor = ctx.cursor || {};
  const listingUrls = source.listingUrls || [];
  const listingIndex = Number.isFinite(cursor.listingIndex) ? cursor.listingIndex : 0;
  const pageNo = Number.isFinite(cursor.pageNo) ? cursor.pageNo : 1;
  const pageUrl = cursor.pageUrl || withPage(listingUrls[listingIndex], pageNo);

  const result = await generic.discoverProducts(Object.assign({}, ctx, { source, cursor: { listingIndex, pageUrl } }));

  // 상품을 찾았고 페이지가 가득 찼으면 다음 페이지로 진행한다.
  if (result.links.length) {
    const next = links.nextListingUrl(pageUrl, null, source) || withPage(listingUrls[listingIndex], pageNo + 1);
    if (next && next !== pageUrl) {
      return Object.assign({}, result, { nextCursor: { listingIndex, pageNo: pageNo + 1, pageUrl: next }, complete: false });
    }
  }
  // 상품이 없으면 다음 목록 URL로 넘어간다
  if (!result.links.length && listingIndex + 1 < listingUrls.length) {
    return Object.assign({}, result, {
      nextCursor: { listingIndex: listingIndex + 1, pageNo: 1, pageUrl: withPage(listingUrls[listingIndex + 1], 1) },
      complete: false,
    });
  }
  return result;
}

async function fetchOffers(ctx) {
  return generic.fetchOffers(Object.assign({}, ctx, { source: reiSource(ctx.source) }));
}

module.exports = { name: "rei-us", discoverProducts, fetchOffers, withPage, reiSource, PRODUCT_ID_PATTERN, PRODUCT_LINK_PATTERN };
