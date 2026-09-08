/* URL 검증·정규화 (브라우저/Node 공용)
 *
 * 예전 크롤러는 `abs.includes(site.domain)`으로 같은 사이트인지 판단했다(리뷰 R11).
 * 그러면 `https://evil.example/?u=www.rei.com` 같은 외부 주소도 통과한다.
 * 여기서는 반드시 URL로 파싱한 뒤 hostname을 비교한다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguUrls = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 내부망·루프백으로 나가는 요청은 만들지 않는다 (SSRF 방지)
  const PRIVATE_HOST_RE = new RegExp(
    [
      "^localhost$",
      "^127\\.",
      "^10\\.",
      "^192\\.168\\.",
      "^172\\.(1[6-9]|2\\d|3[01])\\.",
      "^169\\.254\\.",
      "^0\\.",
      "^\\[?::1\\]?$",
      "\\.local$",
      "\\.internal$",
    ].join("|")
  );

  function parseUrl(raw, base) {
    if (!raw) return null;
    try {
      return base ? new URL(String(raw), String(base)) : new URL(String(raw));
    } catch (e) {
      return null;
    }
  }

  /** http(s) + 공개 호스트인지 */
  function isPublicHttpUrl(raw, base) {
    const u = parseUrl(raw, base);
    if (!u) return false;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname || PRIVATE_HOST_RE.test(u.hostname)) return false;
    return true;
  }

  /** hostname이 허용 목록에 속하는지. 서브도메인은 점 경계로만 인정한다. */
  function hostAllowed(hostname, allowedHosts) {
    if (!hostname || !Array.isArray(allowedHosts) || !allowedHosts.length) return false;
    const host = String(hostname).toLowerCase().replace(/\.$/, "");
    return allowedHosts.some((raw) => {
      const allowed = String(raw || "").toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (!allowed) return false;
      return host === allowed || host.endsWith("." + allowed);
    });
  }

  /**
   * 상대/절대/프로토콜 상대 링크를 절대 URL로 만들고 허용 호스트인지 확인한다.
   * @returns {string|null} 허용되지 않으면 null
   */
  function resolveAllowed(href, baseUrl, allowedHosts) {
    const u = parseUrl(href, baseUrl);
    if (!u) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (PRIVATE_HOST_RE.test(u.hostname)) return null;
    if (!hostAllowed(u.hostname, allowedHosts)) return null;
    return u.toString();
  }

  /**
   * 같은 상품의 절대/상대/쿼리 붙은 URL을 하나로 모으기 위한 정규화 키.
   * 추적 파라미터와 해시, 끝 슬래시를 제거한다.
   */
  const TRACKING_PARAMS = /^(utm_|gclid|fbclid|msclkid|mc_cid|mc_eid|cm_|ir_|sid$|ref$|source$)/i;
  function canonicalizeUrl(raw, base) {
    const u = parseUrl(raw, base);
    if (!u) return null;
    u.hash = "";
    const keep = [];
    u.searchParams.forEach((v, k) => {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    });
    u.search = "";
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).forEach(([k, v]) => u.searchParams.append(k, v));
    let out = u.toString();
    if (u.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  }

  /**
   * 상품 URL에서 안정적인 상품 ID를 뽑는다. 사이트 설정의 productIdPattern(정규식 문자열,
   * 캡처그룹 1개)이 있으면 그걸 쓰고, 없으면 정규화된 URL 전체를 ID로 쓴다.
   */
  function productIdFromUrl(url, productIdPattern) {
    const canonical = canonicalizeUrl(url);
    if (!canonical) return null;
    if (productIdPattern) {
      try {
        const m = new URL(canonical).pathname.match(new RegExp(productIdPattern));
        if (m && m[1]) return m[1];
      } catch (e) {
        /* 잘못된 패턴은 무시하고 URL 전체를 ID로 쓴다 */
      }
    }
    return canonical;
  }

  /** 화면에 렌더링해도 되는 링크인지 (javascript:, data: 차단) */
  function safeHref(raw) {
    const u = parseUrl(raw);
    if (!u) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  }

  /** <img src>로 써도 되는 URL인지 */
  function safeImageUrl(raw) {
    const u = parseUrl(raw);
    if (!u) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  }

  return {
    parseUrl,
    isPublicHttpUrl,
    hostAllowed,
    resolveAllowed,
    canonicalizeUrl,
    productIdFromUrl,
    safeHref,
    safeImageUrl,
  };
});
