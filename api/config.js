// GET /api/config — 브라우저가 쓸 가격 계산 설정을 내려준다.
//
// 화면 안에 세율·배송 요율표를 또 하드코딩해두면 config/cost.yaml을 고쳐도
// 화면 값만 옛날 값으로 남는다(리뷰 R12). 계산 설정은 여기서만 공급한다.
// 비밀값(환경변수·API 키)은 포함하지 않는다.

const { loadConfig, publicConfig } = require("./_lib/landedCost");

module.exports = function handler(req, res) {
  try {
    const cfg = publicConfig(loadConfig());
    // 설정은 자주 바뀌지 않지만, 환율 기준일이 있으므로 짧게만 캐시한다
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json({
      config: cfg,
      configAsOf: (cfg.fx && cfg.fx.as_of) || (cfg.meta && cfg.meta.last_verified) || null,
    });
  } catch (err) {
    res.status(500).json({ error: "설정을 읽지 못했습니다", detail: String(err && err.message) });
  }
};
