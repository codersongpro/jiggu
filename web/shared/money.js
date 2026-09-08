/* 통화·금액 파싱 (브라우저 <script>와 Node require 양쪽에서 그대로 쓴다)
 *
 * 왜 따로 뺐나: 피드/JSON-LD/HTML마다 숫자 표기가 다르다. 같은 "1.299"가 유럽에서는
 * 1299원이고 미국에서는 1.299다. 예전 파서는 마지막 구분자를 무조건 소수점으로 봐서
 * `¥12,800 → 12.8`, `1,299 → 1.299`로 읽었다(리뷰 R05). 금액이 1000배 틀어지면
 * 원가 계산 전체가 무의미해지므로 이 규칙은 한 곳에서만 관리한다.
 *
 * 규칙
 *  1) 구분자가 하나뿐이고 뒤에 정확히 3자리가 오면 천단위 구분자다. (1,299 / 1.299 → 1299)
 *  2) 구분자가 하나뿐이고 뒤가 1~2자리면 소수점이다. (19.99 → 19.99)
 *  3) 구분자가 둘 다 있으면 마지막 것이 소수점이다. (1.299,00 → 1299 / 1,299.00 → 1299)
 *  4) 소수 단위가 없는 통화(JPY·KRW)는 모든 구분자를 천단위로 본다. (¥12,800 → 12800)
 *  5) 위 어느 규칙에도 안 맞으면 추측하지 않고 value:null + warning을 돌려준다.
 *
 * 통화는 명시된 값을 그대로 보존한다. 모르는 통화를 USD로 바꾸지 않는다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguMoney = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 1차 지원 통화 — 원가 계산까지 되는 통화
  const PRIMARY_CURRENCIES = ["USD", "EUR", "JPY", "GBP"];
  // 소수 단위가 없는 통화 (ISO 4217 minor unit 0)
  const ZERO_DECIMAL_CURRENCIES = ["JPY", "KRW", "VND", "CLP", "ISK"];

  const SYMBOL_CURRENCY = [
    { re: /US\s*\$|\$/, cur: "USD" },
    { re: /€|EUR\b/i, cur: "EUR" },
    { re: /£/, cur: "GBP" },
    { re: /¥|円|JPY\b/i, cur: "JPY" },
    { re: /₩|원\b/, cur: "KRW" },
  ];

  const ISO_RE = /\b(USD|EUR|JPY|GBP|KRW|CAD|AUD|CHF|SEK|DKK|NOK|PLN|CZK|HKD|SGD|CNY|TWD)\b/i;

  function isZeroDecimal(currency) {
    return ZERO_DECIMAL_CURRENCIES.indexOf(String(currency || "").toUpperCase()) >= 0;
  }

  /** 문자열에서 통화 코드만 추출한다. 못 찾으면 null (기본값을 임의로 넣지 않는다). */
  function detectCurrency(raw) {
    const s = String(raw == null ? "" : raw);
    const iso = s.match(ISO_RE);
    if (iso) return iso[1].toUpperCase();
    for (const { re, cur } of SYMBOL_CURRENCY) if (re.test(s)) return cur;
    return null;
  }

  /**
   * 숫자만 파싱한다.
   * @returns {{value:number|null, warning:string|null}}
   */
  function parseAmount(raw, currency) {
    if (raw === undefined || raw === null) return { value: null, warning: "금액 없음" };
    if (typeof raw === "number") {
      return Number.isFinite(raw) ? { value: raw, warning: null } : { value: null, warning: "금액이 숫자가 아님" };
    }

    let s = String(raw).trim();
    if (!s) return { value: null, warning: "금액 없음" };

    const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
    // 숫자와 구분자만 남긴다 (공백 천단위 구분도 제거)
    s = s.replace(/[  \s']/g, "").replace(/[^\d.,]/g, "");
    if (!s) return { value: null, warning: "숫자를 찾지 못함" };

    const dots = (s.match(/\./g) || []).length;
    const commas = (s.match(/,/g) || []).length;

    let normalized;
    if (dots === 0 && commas === 0) {
      normalized = s;
    } else if (isZeroDecimal(currency)) {
      // JPY·KRW는 소수 단위가 없다 — 구분자는 전부 천단위
      normalized = s.replace(/[.,]/g, "");
    } else if (dots > 0 && commas > 0) {
      // 마지막에 나오는 쪽이 소수점
      const decimalSep = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
      const groupSep = decimalSep === "." ? "," : ".";
      const parts = s.split(decimalSep);
      if (parts.length !== 2) return { value: null, warning: `구분자 표기가 모호함: ${raw}` };
      normalized = parts[0].split(groupSep).join("") + "." + parts[1];
    } else {
      const sep = dots > 0 ? "." : ",";
      const count = dots > 0 ? dots : commas;
      const groups = s.split(sep);
      const tail = groups[groups.length - 1];
      if (count > 1) {
        // 1.234.567 처럼 여러 번 나오면 전부 천단위 구분자여야 한다
        const allGroupsOk = groups.slice(1).every((g) => g.length === 3);
        if (!allGroupsOk) return { value: null, warning: `구분자 표기가 모호함: ${raw}` };
        normalized = groups.join("");
      } else if (tail.length === 3) {
        // 규칙 1 — 1,299 / 1.299 는 1299
        normalized = groups.join("");
      } else if (tail.length === 1 || tail.length === 2) {
        // 규칙 2 — 19.99 / 19,99 는 소수점
        normalized = groups[0] + "." + tail;
      } else {
        return { value: null, warning: `구분자 표기가 모호함: ${raw}` };
      }
    }

    const value = parseFloat(normalized);
    if (!Number.isFinite(value)) return { value: null, warning: `숫자로 읽을 수 없음: ${raw}` };
    return { value: negative ? -value : value, warning: null };
  }

  /**
   * 금액 + 통화를 함께 읽는다.
   * @param {string|number} raw 예: "¥12,800", "1.299,00 EUR", 19.99
   * @param {{currency?:string, currencyHint?:string}} [opts]
   *        currency     : 피드/응답에 명시된 통화(최우선)
   *        currencyHint : 소스 설정상 예상 통화(문자열에서 못 찾을 때만 사용)
   * @returns {{value:number|null, currency:string|null, warnings:string[]}}
   */
  function parseMoney(raw, opts) {
    const o = opts || {};
    const warnings = [];
    const explicit = o.currency ? String(o.currency).trim().toUpperCase() : "";
    const inline = detectCurrency(raw);

    let currency = explicit || inline || (o.currencyHint ? String(o.currencyHint).toUpperCase() : null);
    if (explicit && inline && explicit !== inline) {
      warnings.push(`통화 불일치: 명시 ${explicit} vs 표기 ${inline} — 명시값을 사용`);
    }
    if (!explicit && !inline && o.currencyHint) {
      warnings.push(`통화 표기 없음 — 소스 설정값(${currency}) 사용`);
    }
    if (!currency) warnings.push("통화를 확인할 수 없음");

    const { value, warning } = parseAmount(raw, currency);
    if (warning) warnings.push(warning);
    return { value, currency, warnings };
  }

  /** 표시용 포맷 (원문 통화 그대로). 지원하지 않는 통화도 코드로 표시한다. */
  function formatMoney(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "-";
    const cur = String(currency || "").toUpperCase();
    const digits = isZeroDecimal(cur) ? 0 : value % 1 === 0 ? 0 : 2;
    const num = value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (cur === "USD") return "$" + num;
    if (cur === "EUR") return "€" + num;
    if (cur === "GBP") return "£" + num;
    if (cur === "JPY") return "¥" + num;
    if (cur === "KRW") return "₩" + num;
    return cur ? `${num} ${cur}` : num;
  }

  return {
    PRIMARY_CURRENCIES,
    ZERO_DECIMAL_CURRENCIES,
    isZeroDecimal,
    detectCurrency,
    parseAmount,
    parseMoney,
    formatMoney,
  };
});
