// 목록 페이지에서 상품 링크를 뽑는 순수 함수들 (리뷰 R11)
//
// 예전에는 href 문자열에 도메인이 '포함'돼 있는지로 같은 사이트인지 판단했다.
// 그러면 https://evil.example/?u=www.rei.com 같은 외부 주소도 통과하고,
// 반대로 `^/product/\d+/` 같은 상대경로 전용 정규식은 같은 상품의 절대 URL을 놓친다.
// 여기서는 항상 URL로 해석한 뒤 hostname과 pathname을 검사한다.

const { XMLParser } = require("fast-xml-parser");
const urls = require("../web/shared/urls.js");

const DEFAULT_LINK_PATTERN = /\/(product|products|p|dp|item|shop)\//;

/**
 * @param {string[]} hrefs  페이지에서 읽은 a[href] 값들 (상대/절대/프로토콜 상대 혼재)
 * @param {{baseUrl:string, source:object, limit?:number}} ctx
 * @returns {{links:Array<{url:string, productId:string}>, skipped:number}}
 */
function collectProductLinks(hrefs, ctx) {
  const source = ctx.source || {};
  const pattern = source.productLinkPattern ? new RegExp(source.productLinkPattern) : DEFAULT_LINK_PATTERN;
  const allowed = source.allowedHosts && source.allowedHosts.length ? source.allowedHosts : [source.domain].filter(Boolean);

  const seen = new Set();
  const links = [];
  let skipped = 0;

  for (const href of hrefs || []) {
    if (!href) continue;
    const abs = urls.resolveAllowed(href, ctx.baseUrl, allowed);
    if (!abs) {
      skipped++;
      continue;
    }
    const u = urls.parseUrl(abs);
    // 패턴은 pathname으로 검사한다 — 절대/상대 URL이 같은 결과를 내야 한다
    if (!pattern.test(u.pathname)) {
      skipped++;
      continue;
    }
    const canonical = urls.canonicalizeUrl(abs);
    const productId = urls.productIdFromUrl(abs, source.productIdPattern);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    links.push({ url: canonical, productId: String(productId) });
    if (ctx.limit && links.length >= ctx.limit) break;
  }
  return { links, skipped };
}

/** sitemap.xml → 하위 사이트맵과 URL 목록 */
function parseSitemap(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, processEntities: true });
  let doc;
  try {
    doc = parser.parse(String(xml || ""));
  } catch (e) {
    return { urls: [], sitemaps: [], error: "사이트맵 XML을 읽지 못함" };
  }
  const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const loc = (n) => (typeof n === "string" ? n : n && n.loc ? String(n.loc) : null);

  const out = { urls: [], sitemaps: [] };
  if (doc.sitemapindex) {
    asArray(doc.sitemapindex.sitemap).forEach((s) => {
      const u = loc(s);
      if (u && urls.isPublicHttpUrl(u)) out.sitemaps.push(u);
    });
  }
  if (doc.urlset) {
    asArray(doc.urlset.url).forEach((s) => {
      const u = loc(s);
      if (u && urls.isPublicHttpUrl(u)) out.urls.push(u);
    });
  }
  return out;
}

/**
 * 다음 목록 페이지 URL을 찾는다.
 * relNext(HTML의 rel="next")가 있으면 그걸 쓰고, 없으면 현재 URL의 page 파라미터를 올린다.
 */
function nextListingUrl(currentUrl, relNext, source) {
  const allowed = (source && source.allowedHosts) || [];
  if (relNext) {
    const abs = urls.resolveAllowed(relNext, currentUrl, allowed);
    if (abs && urls.canonicalizeUrl(abs) !== urls.canonicalizeUrl(currentUrl)) return abs;
  }
  const u = urls.parseUrl(currentUrl);
  if (!u) return null;
  for (const key of ["page", "p", "pageNumber"]) {
    if (u.searchParams.has(key)) {
      const n = parseInt(u.searchParams.get(key), 10);
      if (Number.isFinite(n)) {
        u.searchParams.set(key, String(n + 1));
        return u.toString();
      }
    }
  }
  return null;
}

module.exports = { DEFAULT_LINK_PATTERN, collectProductLinks, parseSitemap, nextListingUrl };
