// 국내 시세 비교 — 상품 상세를 열 때 그 상품 하나만 온디맨드로 조회한다.
// 스캔 한 번에 수천 개 상품을 전부 네이버와 비교하는 건 서버리스 타임아웃상 불가능해서
// 이렇게 설계했다.
//
// 네이버쇼핑 검색 API(openapi.naver.com)를 쓴다. 브랜드+영문 상품명으로 검색해
// 국내 최저가를 찾는 키워드 매칭이라 정확도가 낮다 — PRD.md에도 "가장 큰 난제"로
// 적혀 있던 부분이다. 그래서 결과는 항상 confidence:"low"로 표시하고, 사람이
// 직접 확인하게 한다.
//
// 필요: Vercel 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET
//   1. https://developers.naver.com/apps/#/register 에서 앱 등록(무료)
//   2. 사용 API: 검색 > 쇼핑
//   3. Vercel 프로젝트 Settings > Environment Variables 에 등록
// 키가 없으면 이 기능은 조용히 "설정 필요" 응답만 내려주고 앱의 나머지는 그대로 동작한다.
//
// 이 세션은 외부 네트워크가 막혀 있어 실제 응답을 검증하지 못했다. 네이버 공식 문서의
// 스펙(items[].title/lprice/mallName/link, HTML 태그 포함)대로 작성했다.

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, "");
}

module.exports = async function handler(req, res) {
  const q = (req.query && req.query.q ? String(req.query.q) : "").trim();
  const landedKrw = req.query && req.query.landedKrw ? Number(req.query.landedKrw) : null;

  if (!q) {
    res.status(400).json({ available: false, reason: "검색어(q)가 없습니다" });
    return;
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(200).json({
      available: false,
      reason: "국내 시세 비교를 쓰려면 Vercel 환경변수에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET을 설정하세요 (developers.naver.com에서 무료 발급).",
    });
    return;
  }

  try {
    const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=5&sort=asc`;
    const data = await fetchWithTimeout(url, {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    });

    const items = Array.isArray(data.items) ? data.items : [];
    const results = items.map((it) => ({
      title: stripHtml(it.title),
      priceKrw: Number(it.lprice) || null,
      mallName: it.mallName || "",
      link: it.link || "",
    })).filter((it) => it.priceKrw > 0);

    const cheapestKrw = results.length ? Math.min(...results.map((r) => r.priceKrw)) : null;
    const diffKrw = cheapestKrw != null && landedKrw != null ? landedKrw - cheapestKrw : null;

    res.status(200).json({
      available: true,
      query: q,
      confidence: "low", // 키워드 매칭이라 다른 상품·다른 컬러가 섞일 수 있다. 참고용.
      results,
      cheapestKrw,
      landedKrw,
      diffKrw, // 음수면 해외가 국내보다 저렴, 양수면 국내가 더 저렴
    });
  } catch (e) {
    res.status(200).json({ available: false, reason: "네이버쇼핑 조회 실패: " + e.message });
  }
};
