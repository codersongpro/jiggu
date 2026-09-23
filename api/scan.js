// 스캔 API — config/targets.json에 등록된 판매처를 "한 번에 한 소스의 한 페이지"씩 조회한다.
//
// 왜 조각(chunk) 단위인가: 예전에는 한 번의 호출로 활성 47곳을 전부 훑었고, 브랜드를
// 지정해도 전체를 훑은 뒤 편집숍을 한 번 더 붙여서 같은 사이트에 두 번 요청했다(리뷰 R02).
// 서버리스 실행시간 안에 끝내려고 페이지 수를 4개로 제한해놓고 "브랜드 전체"라고
// 안내하기도 했다(R03). 이제 호출당 한 소스의 한 페이지만 처리하고, 다음 위치를
// nextCursor로 돌려준다. 웹이 cursor를 끝까지 소비해야 그 범위가 완전 수집이 된다.
//
// 응답 필드 중 items / errors / fxRates / sitesTotal / sitesOk / sitesFailed 는
// 기존 화면 호환을 위해 유지한다. sites* 는 "이번 조각에서 처리한 소스 수"다.

const targets = require("../config/targets.json");
const { loadConfig, landedCost } = require("./_lib/landedCost");
const { normalizeProduct } = require("./_lib/shopify");
const sourcesLib = require("../web/shared/sources.js");
const schema = require("../web/shared/schema.js");
const brands = require("../web/shared/brands.js");

const FETCH_TIMEOUT_MS = 8000;
const BUDGET_MS = 45000; // 전체 처리 예산 (서버리스 실행시간 안에서 끝낸다)
const PRODUCTS_PER_PAGE = 250; // Shopify products.json이 허용하는 최대 limit
const MAX_PAGES_PER_SOURCE = 8; // 한 소스에서 이어받을 수 있는 최대 페이지 (cursor 검증용)
const MAX_ITEMS_PER_CHUNK = 25; // 브랜드 미지정 스캔의 응답 크기 제한 (지정 스캔은 캡 없음)

// 세일 스캔(scope=sale) — Shopify 세일 컬렉션(/collections/<handle>/products.json)을 읽는다.
// 전체 목록 1페이지(신상·액세서리 위주)를 훑던 예전 방식은 세일을 거의 못 잡았다.
const DEFAULT_SALE_HANDLES = ["sale"]; // 판매처별 핸들은 targets.json의 saleCollections로 지정
const SALE_BATCH = 5; // 호출당 동시에 볼 판매처 수 (서로 다른 도메인이라 도메인당 동시 1)
const MAX_SALE_PAGES = 2; // 판매처당 세일 컬렉션 최대 페이지 (250 × 2)
const MAX_SALE_ITEMS_PER_SOURCE = 200; // 응답 크기 제한 — 할인율 높은 순으로 자른다

const S = schema.SOURCE_STATUS;
const { sources: SOURCES, errors: SOURCE_ERRORS } = sourcesLib.loadSources(targets);

/** HTTP 응답/예외를 수집 상태로 분류한다. 200인데 HTML이 오는 경우도 성공 0건으로 뭉개지 않는다. */
function classifyHttp(status, bodyHint) {
  if (status === 401 || status === 403) return S.BLOCKED;
  if (status === 404 || status === 410) return S.UNSUPPORTED_ENDPOINT;
  if (status === 429) return S.RATE_LIMITED;
  if (status >= 500) return S.HTTP_ERROR;
  if (status >= 400) return S.HTTP_ERROR;
  if (bodyHint === "challenge") return S.BLOCKED;
  if (bodyHint === "html") return S.RENDER_REQUIRED;
  return S.PARSE_ERROR;
}

class FetchProblem extends Error {
  constructor(status, httpStatus, message, extra) {
    super(message);
    this.status = status;
    this.httpStatus = httpStatus || null;
    Object.assign(this, extra || {});
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; family-sourcing-radar/1.0)", Accept: "application/json" },
    });
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message)));
    throw new FetchProblem(aborted ? S.TIMEOUT : S.HTTP_ERROR, null, aborted ? "요청 시간 초과" : String(err && err.message), {
      stage: "fetch",
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new FetchProblem(classifyHttp(res.status), res.status, `HTTP ${res.status}`, {
      stage: "fetch",
      retryAfter: res.headers && res.headers.get ? res.headers.get("retry-after") : null,
    });
  }

  const head = text.slice(0, 400).toLowerCase();
  if (/captcha|cf-chl|are you a human|access denied|incapsula/.test(head)) {
    throw new FetchProblem(S.BLOCKED, res.status, "봇 차단 화면이 돌아옴", { stage: "parse" });
  }
  if (/^\s*<!doctype|^\s*<html/.test(head)) {
    // 200인데 HTML이면 JSON 엔드포인트가 없는 것 — 성공 0건이 아니다
    throw new FetchProblem(S.RENDER_REQUIRED, res.status, "JSON이 아니라 HTML이 돌아옴", { stage: "parse" });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new FetchProblem(S.PARSE_ERROR, res.status, `JSON 파싱 실패: ${String(err.message).slice(0, 80)}`, { stage: "parse" });
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.products)) {
    // products 배열이 없는 정상 JSON도 "성공 0건"이 아니다(리뷰 R03)
    throw new FetchProblem(S.PARSE_ERROR, res.status, "응답에 products 배열이 없음", { stage: "parse" });
  }
  return data;
}

// 스캔 시점 실시간 환율. 키가 필요 없는 무료 API(유럽중앙은행 기반)를 쓴다.
// 조각마다 다른 환율로 원가를 계산하면 한 번의 스캔 안에서 값이 섞인다(예전에는 첫 조각만
// 실시간, 나머지는 cost.yaml 고정값이었다). 인스턴스 안에서 30분 캐시해 모든 조각이 같은 값을 쓴다.
const FX_CACHE_MS = 30 * 60 * 1000;
let fxCache = null;
async function cachedLiveFxRates() {
  if (fxCache && Date.now() - fxCache.at < FX_CACHE_MS) return fxCache.value;
  const value = await fetchLiveFxRates();
  fxCache = { at: Date.now(), value };
  return value;
}

async function fetchLiveFxRates() {
  const data = await fetchJsonPlain("https://api.frankfurter.dev/v1/latest?base=KRW&symbols=USD,EUR,JPY");
  const r = data && data.rates;
  if (!r || !r.USD || !r.EUR || !r.JPY) throw new Error("환율 응답 형식 이상");
  return { rates: { USD: 1 / r.USD, EUR: 1 / r.EUR, JPY: 1 / r.JPY }, asOf: data.date || null };
}

async function fetchJsonPlain(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** cursor = "<sourceId>:<page>" — 등록된 sourceId와 1~MAX 페이지만 받는다 */
function parseCursor(raw, plan) {
  if (!raw) return { sourceIndex: 0, page: 1 };
  const m = String(raw).match(/^([a-z0-9-]+):(\d{1,2})$/);
  if (!m) return { error: "cursor 형식이 올바르지 않습니다" };
  const idx = plan.findIndex((s) => s.sourceId === m[1]);
  if (idx < 0) return { error: `cursor의 sourceId가 이번 조회 대상에 없습니다: ${m[1]}` };
  const page = parseInt(m[2], 10);
  if (!(page >= 1 && page <= MAX_PAGES_PER_SOURCE)) return { error: "cursor의 페이지 번호가 범위를 벗어났습니다" };
  return { sourceIndex: idx, page };
}

function makeCursor(plan, sourceIndex, page) {
  if (sourceIndex >= plan.length) return null;
  return `${plan[sourceIndex].sourceId}:${page}`;
}

/** Shopify 상품 배열 → 원가까지 붙은 앱 상품 */
function toItems(products, source, cfg, mode, brandId) {
  const normalized = [];
  let rejected = 0;
  products.forEach((p) => {
    const item = normalizeProduct(p, source);
    if (!item) {
      rejected++;
      return;
    }
    if (brandId && !brands.sameBrand(item.brandId || item.brand, brandId)) return;
    const cost = landedCost(
      cfg,
      {
        price: item.salePrice,
        currency: item.currency,
        marketCountry: item.marketCountry,
        region: item.region,
        category: item.category,
        weight_kg: item.weightKg,
      },
      mode
    );
    normalized.push(Object.assign({}, item, { cost, collectedAt: new Date().toISOString(), scopeId: null }));
  });
  return { normalized, rejected };
}

/** 정상 응답으로 볼 수 있는 상태 — partial은 "일부만 확인"이지 실패가 아니다 */
function isFailure(status) {
  return status !== S.OK && status !== S.EMPTY && status !== S.PARTIAL;
}

/**
 * 판매처 하나의 세일 컬렉션을 읽는다.
 * 세일 컬렉션이 없으면(404) 전체 목록 첫 페이지에서 세일 상품만 고르고 partial로 표시한다.
 */
async function scanSaleSource(source, cfg, mode, opts) {
  const started = Date.now();
  const scope = opts.scope;
  const handles = Array.isArray(source.saleCollections) && source.saleCollections.length ? source.saleCollections : DEFAULT_SALE_HANDLES;

  let products = [];
  let pages = 0;
  let listingUrl = null;
  let status = null;
  let failure = null;
  let note = null;

  for (const handle of handles) {
    const collected = [];
    let p = 1;
    let lastErr = null;
    for (; p <= MAX_SALE_PAGES; p++) {
      const url = `${source.baseUrl}/collections/${encodeURIComponent(handle)}/products.json?limit=${PRODUCTS_PER_PAGE}&page=${p}`;
      try {
        const data = await fetchJson(url);
        if (p === 1) listingUrl = url;
        pages++;
        collected.push(...data.products);
        if (data.products.length < PRODUCTS_PER_PAGE) break;
      } catch (err) {
        lastErr = err;
        break;
      }
    }
    if (lastErr && p === 1) {
      // 이 핸들은 없다 → 다음 핸들. 404가 아닌 오류(403·429·타임아웃)는 거기서 멈춘다
      if (lastErr.status === S.UNSUPPORTED_ENDPOINT) continue;
      failure = lastErr;
      listingUrl = `${source.baseUrl}/collections/${handle}/products.json`;
      break;
    }
    products = collected;
    if (lastErr) {
      status = S.PARTIAL;
      note = `세일 컬렉션 ${p}페이지에서 멈춤: ${lastErr.message}`;
    } else if (p > MAX_SALE_PAGES) {
      status = S.PARTIAL;
      note = `세일 상품이 ${PRODUCTS_PER_PAGE * MAX_SALE_PAGES}개를 넘어 앞부분만 확인했습니다`;
    } else {
      status = products.length ? S.OK : S.EMPTY;
    }
    break;
  }

  // 세일 컬렉션이 하나도 없으면 전체 목록 첫 페이지에서 세일 상품만 고른다
  if (!failure && status === null) {
    const url = `${source.baseUrl}/products.json?limit=${PRODUCTS_PER_PAGE}&page=1`;
    listingUrl = url;
    try {
      const data = await fetchJson(url);
      pages++;
      products = data.products;
      status = S.PARTIAL;
      note = "세일 컬렉션이 없어 전체 목록 첫 페이지에서 세일 상품만 골랐습니다 (targets.json saleCollections로 핸들 지정 가능)";
    } catch (err) {
      failure = err;
    }
  }

  if (failure) {
    return {
      items: [],
      sourceResult: schema.makeSourceResult(source, {
        scope,
        status: failure.status || S.HTTP_ERROR,
        httpStatus: failure.httpStatus,
        stage: failure.stage || "fetch",
        retryAfter: failure.retryAfter || null,
        error: failure.message,
        pages: Math.max(pages, 1),
        listingUrl,
        complete: false,
      }),
    };
  }

  const { normalized, rejected } = toItems(products, source, cfg, mode, opts.brandId);
  const onSale = normalized.filter((it) => it.listPrice > it.salePrice).sort((a, b) => b.offRate - a.offRate);
  let items = onSale;
  if (items.length > MAX_SALE_ITEMS_PER_SOURCE) {
    items = items.slice(0, MAX_SALE_ITEMS_PER_SOURCE);
    status = S.PARTIAL;
    note = `세일 상품 ${onSale.length}개 중 할인율 높은 ${MAX_SALE_ITEMS_PER_SOURCE}개만 반환했습니다`;
  }

  const sourceResult = schema.makeSourceResult(source, {
    scope,
    status,
    httpStatus: 200,
    stage: null,
    discovered: products.length,
    fetched: products.length,
    accepted: items.length,
    rejected: rejected + (normalized.length - items.length),
    pages,
    listingUrl,
    complete: false,
    error: note,
  });
  sourceResult.durationMs = Date.now() - started;
  sourceResult.saleCount = onSale.length;
  const scopeId = schema.scopeKey(sourceResult);
  items.forEach((it) => {
    it.scopeId = scopeId;
  });
  return { items, sourceResult };
}

/** 소스 하나의 한 페이지를 조회한다 */
async function scanSourcePage(source, page, cfg, mode, opts) {
  const url = `${source.baseUrl}/products.json?limit=${PRODUCTS_PER_PAGE}&page=${page}`;
  const scope = opts.scope;
  const started = Date.now();

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    return {
      items: [],
      sourceResult: schema.makeSourceResult(source, {
        scope,
        status: err.status || S.HTTP_ERROR,
        httpStatus: err.httpStatus,
        stage: err.stage || "fetch",
        retryAfter: err.retryAfter || null,
        error: err.message,
        pages: 1,
        listingUrl: url,
        complete: false,
      }),
      exhausted: true,
    };
  }

  const products = data.products;
  const { normalized, rejected } = toItems(products, source, cfg, mode, opts.brandId);

  const onSale = normalized.filter((it) => it.listPrice > it.salePrice).sort((a, b) => b.offRate - a.offRate);
  const regular = normalized
    .filter((it) => !(it.listPrice > it.salePrice))
    .sort((a, b) => (a.cost.totalKrw || Infinity) - (b.cost.totalKrw || Infinity));

  let items = [...onSale, ...regular];
  let capped = false;
  if (!opts.uncapped && items.length > MAX_ITEMS_PER_CHUNK) {
    // 세일 상품에 70%를 먼저 배정하되, 세일이 적으면 남는 칸을 일반 상품으로 채운다
    // (예전에는 세일 0건일 때 일반 상품 7건만 돌려줬다 — 2026-09-23 배포 스캔에서 확인)
    const saleTake = Math.min(onSale.length, Math.max(Math.ceil(MAX_ITEMS_PER_CHUNK * 0.7), MAX_ITEMS_PER_CHUNK - regular.length));
    items = [...onSale.slice(0, saleTake), ...regular.slice(0, MAX_ITEMS_PER_CHUNK - saleTake)];
    capped = true;
  }

  // 이 페이지가 마지막인지 — 250개 미만이면 더 없다
  const exhausted = products.length < PRODUCTS_PER_PAGE || page >= MAX_PAGES_PER_SOURCE;

  const sourceResult = schema.makeSourceResult(source, {
    scope,
    status: products.length === 0 ? S.EMPTY : capped ? S.PARTIAL : S.OK,
    httpStatus: 200,
    stage: null,
    discovered: products.length,
    fetched: products.length,
    accepted: items.length,
    rejected: rejected + (normalized.length - items.length),
    pages: 1,
    listingUrl: url,
    complete: false, // 완전 수집 판정은 cursor를 끝까지 소비한 웹/CLI가 한다
    error: capped ? `응답 크기 제한으로 이 페이지에서 ${MAX_ITEMS_PER_CHUNK}건만 반환했습니다` : null,
  });
  sourceResult.durationMs = Date.now() - started;

  const scopeId = schema.scopeKey(sourceResult);
  items.forEach((it) => {
    it.scopeId = scopeId;
  });

  return { items, sourceResult, exhausted };
}

module.exports = async function handler(req, res) {
  const q = (req && req.query) || {};
  const mode = q.mode === "business" ? "business" : "proxy";
  const brandInput = q.brand ? String(q.brand).trim() : "";
  const brandId = brandInput ? brands.canonicalBrandId(brandInput) || brandInput.toLowerCase() : "";
  const onlyPopular = q.onlyPopular === "1";
  const sourceIdParam = q.sourceId ? String(q.sourceId).trim() : "";
  const marketCountry = q.marketCountry ? String(q.marketCountry).trim().toUpperCase() : "";
  const saleScope = q.scope === "sale";

  const cfg = loadConfig();

  // 조회 대상 계획 — 브랜드를 지정하면 그 브랜드의 공식몰 + 편집숍만 본다
  const plan = sourcesLib.selectSources(SOURCES, {
    runtime: "server",
    adapters: ["shopify-products-json"],
    brandId: brandId || null,
    onlyPopular: saleScope ? false : onlyPopular,
    sourceIds: sourceIdParam ? [sourceIdParam] : null,
    marketCountries: marketCountry ? [marketCountry] : null,
  });

  if (!plan.length) {
    res.status(200).json({
      schemaVersion: schema.SCHEMA_VERSION,
      scannedAt: new Date().toISOString(),
      mode,
      chunk: true,
      nextCursor: null,
      plannedSources: [],
      sourceResults: [],
      sitesTotal: 0,
      sitesOk: 0,
      sitesFailed: 0,
      itemCount: 0,
      brandSummary: {},
      items: [],
      errors: [],
      fxRates: { USD: cfg.fx.base_rate.USD, EUR: cfg.fx.base_rate.EUR, JPY: cfg.fx.base_rate.JPY },
      fxSource: "cost.yaml 고정값",
      configErrors: SOURCE_ERRORS,
      note: sourceIdParam ? "요청한 sourceId가 등록돼 있지 않거나 차단 상태입니다" : "조건에 맞는 판매처가 없습니다",
    });
    return;
  }

  const cursor = parseCursor(q.cursor, plan);
  if (cursor.error) {
    res.status(400).json({ error: cursor.error });
    return;
  }

  // 환율 — 캐시된 실시간 값을 모든 조각에 똑같이 쓴다. 실패하면 cost.yaml 고정값
  let fxSource = "cost.yaml 고정값";
  let fxAsOf = (cfg.fx && cfg.fx.as_of) || null;
  try {
    const live = await cachedLiveFxRates();
    cfg.fx.base_rate = Object.assign({}, cfg.fx.base_rate, live.rates);
    fxSource = "실시간(frankfurter.dev, ECB 기준)";
    fxAsOf = live.asOf || fxAsOf;
    cfg.fx.source = fxSource;
    if (live.asOf) cfg.fx.as_of = live.asOf;
  } catch (e) {
    // 환율 API가 막히면 cost.yaml 고정값으로 계속 진행한다
  }

  // 세일 스캔은 브랜드를 지정해도 "세일 컬렉션" 범위다 — 전체 목록 범위와 섞지 않는다
  const scope = saleScope
    ? { kind: "sale", value: brandId || null }
    : brandId
    ? { kind: "brand", value: brandId }
    : onlyPopular
    ? { kind: "popular", value: null }
    : { kind: "listing", value: null };

  const started = Date.now();
  const items = [];
  const sourceResults = [];
  const errors = [];

  let sourceIndex = cursor.sourceIndex;
  let page = cursor.page;
  let nextCursor = null;

  const pushError = (source, sr) => {
    if (!isFailure(sr.status)) return;
    errors.push({
      sourceId: source.sourceId,
      brand: source.shopName,
      domain: source.domain,
      status: sr.status,
      httpStatus: sr.httpStatus,
      error: sr.error,
    });
  };

  if (saleScope) {
    // 세일 스캔: 호출당 판매처 SALE_BATCH곳을 병렬로 본다(서로 다른 도메인, 도메인당 요청은 순차).
    const batch = plan.slice(sourceIndex, sourceIndex + SALE_BATCH);
    const results = await Promise.all(
      batch.map((source) =>
        // 한 판매처의 예외가 같은 묶음의 다른 판매처 결과까지 날리지 않게 판매처별로 가둔다
        scanSaleSource(source, cfg, mode, { brandId: brandId || null, scope }).catch((err) => ({
          items: [],
          sourceResult: schema.makeSourceResult(source, {
            scope,
            status: S.PARSE_ERROR,
            stage: "parse",
            error: String((err && err.message) || err).slice(0, 120),
            pages: 1,
            complete: false,
          }),
        }))
      )
    );
    results.forEach((r, i) => {
      items.push(...r.items);
      sourceResults.push(r.sourceResult);
      pushError(batch[i], r.sourceResult);
    });
    sourceIndex += batch.length;
    nextCursor = makeCursor(plan, sourceIndex, 1);
  } else {
    // 목록/브랜드 스캔: 호출당 "한 소스의 한 페이지"
    const source = plan[sourceIndex];
    const result = await scanSourcePage(source, page, cfg, mode, {
      brandId: brandId || null,
      uncapped: !!(brandId || sourceIdParam),
      scope,
    });
    items.push(...result.items);
    sourceResults.push(result.sourceResult);
    pushError(source, result.sourceResult);

    if (result.exhausted) {
      sourceIndex += 1;
      page = 1;
    } else {
      page += 1;
    }
    nextCursor = makeCursor(plan, sourceIndex, page);
    // sourceId를 지정한 호출은 그 판매처 안에서만 진행한다
    if (sourceIdParam && result.exhausted) nextCursor = null;
  }

  if (sourceIndex >= plan.length) nextCursor = null;

  const brandSummary = {};
  items
    .filter((it) => it.listPrice > it.salePrice)
    .forEach((it) => {
      const label = brands.brandLabel(it.brandId, it.brand);
      brandSummary[label] = (brandSummary[label] || 0) + 1;
    });

  res.status(200).json({
    schemaVersion: schema.SCHEMA_VERSION,
    scannedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    mode,
    chunk: true,
    nextCursor,
    plannedSources: plan.map((s) => ({
      sourceId: s.sourceId,
      shopName: s.shopName,
      marketCountry: s.marketCountry,
      kind: s.kind,
    })),
    scope,
    sourceResults,
    // 아래 세 값은 "이번 조각에서 처리한 소스 수"다. 전체 진행률은 웹이 누적한다.
    sitesTotal: sourceResults.length,
    sitesOk: sourceResults.filter((r) => !isFailure(r.status)).length,
    sitesFailed: errors.length,
    itemCount: items.length,
    brandSummary,
    items,
    errors,
    fxRates: { USD: cfg.fx.base_rate.USD, EUR: cfg.fx.base_rate.EUR, JPY: cfg.fx.base_rate.JPY },
    fxSource,
    fxAsOf,
    elapsedMs: Date.now() - started,
    budgetMs: BUDGET_MS,
  });
};

// 테스트용 노출 (Vercel은 module.exports가 함수면 그대로 핸들러로 쓴다)
module.exports.scanSourcePage = scanSourcePage;
module.exports.scanSaleSource = scanSaleSource;
module.exports.parseCursor = parseCursor;
module.exports.classifyHttp = classifyHttp;
module.exports.SOURCES = SOURCES;
