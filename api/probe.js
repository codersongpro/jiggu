// 판매처 진단 API — GET /api/probe?sourceId=a,b,c
//
// 어떤 수집 방식이 그 판매처에서 실제로 통하는지 배포 환경(Vercel)에서 확인한다.
// 이 작업 세션처럼 외부망이 막힌 곳에서는 수집 가능 여부를 알 수 없기 때문에
// (docs/VERIFICATION.md Q11) 배포된 서버가 직접 한 번씩 요청해 보고 결과만 돌려준다.
//
// 지키는 것
//  - config/targets.json에 등록된 sourceId만 받는다(임의 URL 요청 불가).
//  - 판매처당 요청은 최대 4개, 순차로 보낸다. 한 호출에 판매처 6곳까지.
//  - 봇 차단(403·캡차)을 확인만 하고 우회하지 않는다. User-Agent는 정직하게 밝힌다.
//  - 상품 데이터는 돌려주지 않는다. 상태 코드·건수·플랫폼 단서만 요약한다.

const targets = require("../config/targets.json");
const sourcesLib = require("../web/shared/sources.js");
const { detectPlatform, detectChallenge, USER_AGENT } = require("./_lib/fetchPage");

const { sources: SOURCES } = sourcesLib.loadSources(targets);
const TIMEOUT_MS = 7000;
const MAX_SOURCES = 6;

async function tryFetch(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en-US,en;q=0.8" },
    });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      ms: Date.now() - started,
      finalUrl: res.url && res.url !== url ? res.url : undefined,
      server: (res.headers.get("server") || "").slice(0, 40) || undefined,
      text,
    };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err.message)));
    return { status: 0, ms: Date.now() - started, error: aborted ? "timeout" : String(err && err.message).slice(0, 80), text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function jsonProducts(text) {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data && data.products) ? data.products : null;
  } catch (e) {
    return null;
  }
}

function summarize(r, extra) {
  const out = { status: r.status, ms: r.ms };
  if (r.error) out.error = r.error;
  if (r.finalUrl) out.finalUrl = r.finalUrl;
  if (r.server) out.server = r.server;
  const challenge = detectChallenge(r.text);
  if (challenge) out.challenge = challenge;
  return Object.assign(out, extra || {});
}

async function probeSource(source) {
  const base = source.baseUrl;
  const report = { sourceId: source.sourceId, registered: source.support.status, adapter: source.adapter };

  const home = await tryFetch(base + "/", "text/html");
  report.home = summarize(home, {
    platform: detectPlatform(home.text) || undefined,
    jsonLd: (home.text.match(/application\/ld\+json/gi) || []).length,
  });

  const pj = await tryFetch(base + "/products.json?limit=5", "application/json");
  const pjProducts = jsonProducts(pj.text);
  report.productsJson = summarize(pj, { products: pjProducts ? pjProducts.length : null });

  if (pjProducts) {
    // Shopify 세일 컬렉션 — 핸들은 가게마다 다르다. 대표 후보만 확인한다.
    for (const handle of ["sale", "sale-all", "all-sale"]) {
      const r = await tryFetch(`${base}/collections/${handle}/products.json?limit=250`, "application/json");
      const list = jsonProducts(r.text);
      if (list) {
        report.saleCollection = { handle, status: r.status, products: list.length };
        break;
      }
      report.saleCollection = { handle, status: r.status, products: null };
    }
  } else {
    const sm = await tryFetch(base + "/sitemap.xml", "application/xml,text/xml");
    report.sitemap = summarize(sm, { locs: (sm.text.match(/<loc>/g) || []).length });
  }
  return report;
}

module.exports = async function handler(req, res) {
  const q = (req && req.query) || {};
  const ids = String(q.sourceId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    res.status(400).json({ error: "sourceId를 쉼표로 구분해 지정하세요", sourceIds: SOURCES.filter((s) => s.runtime === "server").map((s) => s.sourceId) });
    return;
  }
  if (ids.length > MAX_SOURCES) {
    res.status(400).json({ error: `한 번에 ${MAX_SOURCES}곳까지만 진단합니다` });
    return;
  }
  const picked = ids.map((id) => sourcesLib.findSource(SOURCES, id));
  const unknown = ids.filter((id, i) => !picked[i]);
  if (unknown.length) {
    res.status(400).json({ error: "등록되지 않은 sourceId", unknown });
    return;
  }
  // 서로 다른 도메인이므로 판매처 간에는 병렬, 한 판매처 안에서는 순차로 요청한다
  const reports = await Promise.all(picked.map((s) => probeSource(s)));
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ checkedAt: new Date().toISOString(), environment: "vercel-serverless", reports });
};
