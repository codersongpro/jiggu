// 공용 브라우저 수집 어댑터 — 공개 페이지의 구조화 데이터(JSON-LD)를 읽는다.
//
// 고친 것 (리뷰 R07)
//  - DOMContentLoaded 직후 바로 추출하지 않고, 상품 링크나 구조화 데이터가 실제로
//    나타날 때까지 기다린다(지연 렌더링 대응).
//  - 상품 상세 404 하나에 그 뒤 상품까지 멈추던 동작을 없앴다. 개별 404는 건너뛰고,
//    캡차·명시적 차단·robots 제한일 때만 그 판매처를 중단한다.
//  - 목록 진행(다음 페이지)을 cursor로 기록해 이어받기가 가능하다.
//
// 봇 탐지 우회는 하지 않는다. TLS 지문 위장·Stealth 플러그인·주거용 프록시·캡차
// 자동 풀이는 쓰지 않는다. 차단이 확인되면 그 소스는 blocked로 기록하고 멈춘다.

const jsonld = require("./jsonld.js");
const links = require("./links.js");
const schema = require("../web/shared/schema.js");
const urls = require("../web/shared/urls.js");

const S = schema.SOURCE_STATUS;
const NAV_TIMEOUT_MS = 25000;
const READY_TIMEOUT_MS = 12000;

const BLOCK_HINTS = /captcha|are you a human|access denied|blocked|incapsula|cf-chl|请稍候|verify you are human/i;

/** 브라우저 이동 실패 메시지를 상태로 옮긴다. 시간 초과와 연결 실패는 다른 진단이다. */
function statusFromNavError(message) {
  const m = String(message || "");
  if (/timeout|exceeded/i.test(m)) return S.TIMEOUT;
  return S.HTTP_ERROR; // ERR_TUNNEL_CONNECTION_FAILED, ERR_NAME_NOT_RESOLVED 등
}

/** 페이지 응답 상태를 수집 상태로 옮긴다 */
function statusFromResponse(res) {
  if (!res) return null;
  const code = res.status();
  if (code === 403 || code === 401) return { status: S.BLOCKED, httpStatus: code };
  if (code === 404 || code === 410) return { status: S.UNSUPPORTED_ENDPOINT, httpStatus: code };
  if (code === 429) return { status: S.RATE_LIMITED, httpStatus: code };
  if (code >= 500) return { status: S.HTTP_ERROR, httpStatus: code };
  if (code >= 400) return { status: S.HTTP_ERROR, httpStatus: code };
  return null;
}

/** 상품 링크나 구조화 데이터가 실제로 나타날 때까지 기다린다 */
async function waitForContent(page, source) {
  const selectors = [source.readySelector, 'script[type="application/ld+json"]', "a[href]"].filter(Boolean);
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: READY_TIMEOUT_MS, state: "attached" });
      return sel;
    } catch (e) {
      /* 다음 후보로 */
    }
  }
  return null;
}

async function readJsonLdBlocks(page) {
  return page.$$eval('script[type="application/ld+json"]', (nodes) => nodes.map((n) => n.textContent));
}

/**
 * 목록에서 상품 URL을 찾는다.
 * @param {{page:object, source:object, cursor:object|null, limit:number, log:Function}} ctx
 */
async function discoverProducts(ctx) {
  const { page, source, limit } = ctx;
  const cursor = ctx.cursor || {};
  const listingUrls = source.listingUrls || [];
  let listingIndex = Number.isFinite(cursor.listingIndex) ? cursor.listingIndex : 0;
  let pageUrl = cursor.pageUrl || listingUrls[listingIndex];

  if (!pageUrl) {
    return { links: [], nextCursor: null, complete: true, status: S.EMPTY, pages: 0, listingUrl: null };
  }
  if (!urls.resolveAllowed(pageUrl, source.baseUrl, source.allowedHosts)) {
    return { links: [], nextCursor: null, complete: false, status: S.BLOCKED, error: "허용되지 않은 목록 URL", listingUrl: pageUrl };
  }

  let res;
  try {
    res = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    return { links: [], nextCursor: null, complete: false, status: statusFromNavError(err.message), error: String(err.message).slice(0, 200), listingUrl: pageUrl };
  }
  const bad = statusFromResponse(res);
  if (bad) return { links: [], nextCursor: null, complete: false, status: bad.status, httpStatus: bad.httpStatus, listingUrl: pageUrl };

  await waitForContent(page, source);

  const html = await page.content();
  if (BLOCK_HINTS.test(html.slice(0, 3000))) {
    return { links: [], nextCursor: null, complete: false, status: S.BLOCKED, error: "봇 차단 화면", listingUrl: pageUrl };
  }

  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  const relNext = await page
    .$eval('link[rel="next"], a[rel="next"]', (el) => el.getAttribute("href"))
    .catch(() => null);

  const found = links.collectProductLinks(hrefs, { baseUrl: page.url(), source, limit });

  // 다음 위치: 같은 목록의 다음 페이지 → 없으면 다음 목록 URL
  const next = links.nextListingUrl(page.url(), relNext, source);
  let nextCursor = null;
  if (next && found.links.length) nextCursor = { listingIndex, pageUrl: next };
  else if (listingIndex + 1 < listingUrls.length) nextCursor = { listingIndex: listingIndex + 1, pageUrl: listingUrls[listingIndex + 1] };

  return {
    links: found.links,
    nextCursor,
    complete: !nextCursor,
    status: found.links.length ? S.OK : S.EMPTY,
    httpStatus: res ? res.status() : null,
    pages: 1,
    listingUrl: pageUrl,
    skipped: found.skipped,
  };
}

/**
 * 상품 상세에서 옵션별 Offer를 읽는다.
 * @param {{page:object, source:object, url:string}} ctx
 */
async function fetchOffers(ctx) {
  const { page, source, url } = ctx;
  if (!urls.resolveAllowed(url, source.baseUrl, source.allowedHosts)) {
    return { item: null, status: S.BLOCKED, error: "허용되지 않은 상품 URL" };
  }

  let res;
  try {
    res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    return { item: null, status: statusFromNavError(err.message), error: String(err.message).slice(0, 200) };
  }
  const bad = statusFromResponse(res);
  // 개별 상품 404는 그 상품만 건너뛴다 — 사이트 전체 차단으로 바꾸지 않는다
  if (bad) return { item: null, status: bad.status, httpStatus: bad.httpStatus };

  await waitForContent(page, source);

  const blocks = await readJsonLdBlocks(page);
  const extracted = jsonld.extractProduct(blocks, { url: page.url(), source });
  if (!extracted.item) {
    return { item: null, status: S.RENDER_REQUIRED, error: extracted.error, warnings: extracted.warnings };
  }
  return { item: extracted.item, status: S.OK, httpStatus: res ? res.status() : 200, warnings: extracted.warnings };
}

module.exports = {
  name: "jsonld-browser",
  discoverProducts,
  fetchOffers,
  statusFromNavError,
  waitForContent,
  statusFromResponse,
  NAV_TIMEOUT_MS,
  READY_TIMEOUT_MS,
};
