// 서버 수집 공용 도구 — User-Agent, 봇 차단 화면 감지, 쇼핑몰 플랫폼 추정
//
// 봇 차단을 "감지"만 한다. 감지되면 그 판매처는 중단하고 기록한다(CLAUDE.md 데이터 규칙 7).

// 정직한 User-Agent. 브라우저로 위장하지 않는다.
const USER_AGENT = "Mozilla/5.0 (compatible; family-sourcing-radar/1.0)";

const CHALLENGE_PATTERNS = [
  { name: "cloudflare", re: /cf-chl|challenge-platform|cf_chl_opt|just a moment\.\.\./i },
  { name: "perimeterx", re: /px-captcha|_pxAppId|perimeterx/i },
  { name: "datadome", re: /datadome|dd\.captcha|geo\.captcha-delivery/i },
  { name: "akamai", re: /akamai.{0,40}(bot|denied)|_abck|bm-verify/i },
  { name: "incapsula", re: /incapsula|_Incapsula_Resource/i },
  { name: "captcha", re: /captcha|are you a human|access denied|request unsuccessful/i },
];

/** 응답 본문 앞부분으로 봇 차단 화면인지 판단한다. 아니면 null */
function detectChallenge(text) {
  if (!text) return null;
  const head = String(text).slice(0, 4000);
  const hit = CHALLENGE_PATTERNS.find((p) => p.re.test(head));
  return hit ? hit.name : null;
}

const PLATFORM_PATTERNS = [
  { name: "shopify", re: /cdn\.shopify\.com|Shopify\.shop\s*=|shopify-section/i },
  { name: "salesforce-cc", re: /demandware|dwstatic|on\/demandware\.store|dw\/image/i },
  { name: "magento", re: /Magento_|mage\/cookies|static\/version\d+/i },
  { name: "bigcommerce", re: /bigcommerce\.com|stencil-utils/i },
  { name: "nextjs", re: /__NEXT_DATA__|\/_next\/static/i },
];

/** HTML 단서로 쇼핑몰 플랫폼을 추정한다(진단 표시용). 모르면 null */
function detectPlatform(html) {
  if (!html) return null;
  const hit = PLATFORM_PATTERNS.find((p) => p.re.test(html));
  return hit ? hit.name : null;
}

module.exports = { USER_AGENT, detectChallenge, detectPlatform };
