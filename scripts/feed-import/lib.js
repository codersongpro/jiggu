// 어필리에이트 상품 피드 파싱·변환 라이브러리 (CLI는 import-feed.js)
//
// 고친 것 (리뷰 R05·R06)
//  - 숫자 파싱을 web/shared/money.js로 통일: ¥12,800 → 12800, 1.299,00 → 1299,
//    19.99 GBP → 19.99(GBP 유지). 명시된 통화를 USD로 바꾸지 않는다.
//  - Google Shopping의 g:price만 있는 상품도 정상 처리한다.
//  - 재고 수량 10을 '0을 포함한다'는 이유로 품절 처리하던 문제 수정.
//  - XML은 정규식 대신 fast-xml-parser로 읽어 &amp; 같은 엔티티를 제대로 해석한다.
//  - cost.yaml이 다루지 않는 통화(GBP 등)의 상품도 버리지 않고, 원문 가격은 보존한 채
//    원가만 "계산 미완료"로 남긴다.

const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const money = require("../../web/shared/money.js");
const offers = require("../../web/shared/offers.js");
const brands = require("../../web/shared/brands.js");
const urls = require("../../web/shared/urls.js");

const DEFAULT_LIMIT = 1000;
const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };

// 통화 → 시장(국가). EUR는 여러 나라가 쓰므로 통화만으로 국가를 정하지 않는다(--market으로 지정).
const CURRENCY_MARKET = { USD: "US", EUR: null, JPY: "JP", GBP: "GB" };
// 통화 → 원가 계산 프로필. GBP는 일부러 비워둔다 — 영국을 EU 규칙에 넣지 않는다.
const CURRENCY_REGION = { USD: "US", EUR: "EU", JPY: "JP" };

const FIELD_ALIASES = {
  name: ["name", "title", "productname", "product", "gtitle"],
  brand: ["brand", "manufacturer", "brandname", "gbrand", "manufacturername"],
  sku: ["sku", "gid", "productid", "mpn", "gmpn", "partnumber", "id", "merchantsku"],
  listPrice: ["retailprice", "regularprice", "listprice", "msrp", "rrp", "originalprice"],
  salePrice: ["saleprice", "gsaleprice", "discountprice", "currentprice", "specialprice"],
  price: ["price", "gprice"], // 정가/할인가 구분 없는 단일 가격 컬럼
  currency: ["currency", "currencycode", "pricecurrency", "gpricecurrency"],
  url: ["link", "glink", "buyurl", "producturl", "clickurl", "awdeeplink", "destinationurl", "url", "trackinglink"],
  image: ["imageurl", "gimagelink", "image", "largeimage", "merchantimageurl", "awimageurl", "imagelink", "mainimage"],
  category: ["category", "producttype", "gproducttype", "primarycategory", "ggoogleproductcategory", "categoryname"],
  availability: ["availability", "instock", "stockavailability", "gavailability", "quantity", "gquantity"],
  size: ["size", "gsize"],
  color: ["color", "colour", "gcolor"],
};

const CATEGORY_KEYWORDS = [
  { cat: "shoes", w: /shoe|sneaker|boot|loafer|sandal|heel|pump|slipper/i },
  { cat: "bag", w: /\bbag\b|tote|backpack|clutch|wallet|purse|handbag|satchel|crossbody/i },
  { cat: "watch", w: /watch/i },
  { cat: "accessory", w: /sunglass|jewel|belt|scarf|\bhat\b|glove|earring|necklace|bracelet|ring\b/i },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-:]/g, "");

// ---------- 구분자 있는 텍스트 피드(CSV/TSV/파이프) ----------
// 따옴표 안의 구분자·줄바꿈·이스케이프된 따옴표까지 처리한다.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() || [];
  return rows
    .filter((r) => r.length && r.some((c) => c !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? "" : r[i]])));
}

function detectDelimiter(firstLine) {
  const counts = [
    { d: "\t", n: (firstLine.match(/\t/g) || []).length },
    { d: "|", n: (firstLine.match(/\|/g) || []).length },
    { d: ",", n: (firstLine.match(/,/g) || []).length },
  ];
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

// ---------- XML 피드 (Google Shopping / RSS / Atom) ----------
function parseXml(text) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    trimValues: true,
    parseTagValue: false, // 숫자 변환은 money.js가 한다 (12,800이 12.8이 되면 안 된다)
    processEntities: true, // &amp; &#39; 등을 제대로 해석한다
    cdataPropName: "__cdata",
  });
  const doc = parser.parse(text);

  const rows = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const tag = key.replace(/^.*:/, "").toLowerCase();
      if (tag === "item" || tag === "entry" || tag === "product") {
        (Array.isArray(value) ? value : [value]).forEach((entry) => {
          if (entry && typeof entry === "object") rows.push(flattenEntry(entry));
        });
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(doc);
  return rows;
}

function flattenEntry(entry) {
  const row = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith("@")) continue;
    const name = key;
    let v = value;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") {
      // <g:price currency="USD">10.00</g:price> 처럼 속성이 붙은 경우
      if (v.__cdata !== undefined) v = v.__cdata;
      else if (v["#text"] !== undefined) {
        if (v["@currency"]) row[name + "_currency"] = String(v["@currency"]);
        v = v["#text"];
      } else continue;
    }
    if (v === undefined || v === null) continue;
    row[name] = String(v);
  }
  return row;
}

function loadFeed(file) {
  const text = fs.readFileSync(file, "utf-8");
  if (/^\s*<\?xml|^\s*<rss|^\s*<feed|^\s*<products/i.test(text)) return { rows: parseXml(text), format: "XML" };
  const nl = text.indexOf("\n");
  const firstLine = text.slice(0, nl >= 0 ? nl : 500);
  const delimiter = detectDelimiter(firstLine);
  return {
    rows: parseDelimited(text, delimiter),
    format: delimiter === "\t" ? "TSV" : delimiter === "|" ? "PIPE" : "CSV",
  };
}

// ---------- 컬럼 매핑 ----------
function buildMapping(sampleRow, overrides) {
  const columns = Object.keys(sampleRow);
  const byNorm = new Map(columns.map((c) => [norm(c.replace(/^g:/i, "g")), c]));
  const mapping = {};
  const ov = overrides || {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (ov[field]) { mapping[field] = ov[field]; continue; }
    for (const alias of aliases) {
      if (byNorm.has(alias)) { mapping[field] = byNorm.get(alias); break; }
    }
  }
  return mapping;
}

function detectCategory(text, fallback) {
  const hit = CATEGORY_KEYWORDS.find((c) => c.w.test(text));
  return hit ? hit.cat : fallback;
}

/** 행에서 통화를 읽는다. 명시된 값이 최우선이고, 임의로 USD를 넣지 않는다. */
function currencyFrom(row, mapping, fallback) {
  const explicit = mapping.currency ? String(row[mapping.currency] || "").trim().toUpperCase() : "";
  if (/^[A-Z]{3}$/.test(explicit)) return explicit;

  // <g:price currency="GBP">처럼 속성으로 온 경우 (parseXml이 _currency로 붙여둔다)
  for (const key of [mapping.salePrice, mapping.price, mapping.listPrice]) {
    if (!key) continue;
    const attr = row[key + "_currency"];
    if (attr && /^[A-Z]{3}$/i.test(String(attr))) return String(attr).toUpperCase();
  }

  // "1299.00 USD" / "£19.99"처럼 가격 문자열에 통화가 붙어 오는 피드
  for (const key of [mapping.salePrice, mapping.price, mapping.listPrice]) {
    if (!key) continue;
    const detected = money.detectCurrency(row[key]);
    if (detected) return detected;
  }
  return fallback || null;
}

/**
 * 피드 행 하나 → 앱 상품.
 * @returns {{item:object}|{skip:string}}
 */
function toItem(row, mapping, opts, index) {
  const name = mapping.name ? String(row[mapping.name] || "").trim() : "";
  if (!name) return { skip: "상품명 없음" };

  const availability = mapping.availability ? offers.normalizeAvailability(row[mapping.availability]) : "unknown";
  if (availability === "out_of_stock") return { skip: "품절" };

  const currency = currencyFrom(row, mapping, opts.currencyFallback);
  if (!currency) return { skip: "통화를 확인할 수 없음" };

  const warnings = [];
  const read = (field) => {
    if (!mapping[field]) return null;
    const r = money.parseMoney(row[mapping[field]], { currency });
    if (r.value === null && String(row[mapping[field]] || "").trim()) {
      warnings.push(`${field} 값을 읽지 못함: ${row[mapping[field]]}`);
    }
    return r.value;
  };

  // g:price만 있는 피드(단일 가격), sale/list가 따로 있는 피드 모두 받는다
  const single = read("price");
  const sale = read("salePrice");
  const list = read("listPrice");

  const salePrice = sale !== null && sale > 0 ? sale : single !== null && single > 0 ? single : list;
  if (!(salePrice > 0)) return { skip: warnings[0] || "가격 없음" };

  // 정가는 같은 상품의 값이 판매가보다 클 때만 인정한다
  const listCandidate = list !== null && list > 0 ? list : sale !== null && sale > 0 && single !== null && single > sale ? single : null;
  const listPrice = listCandidate !== null && listCandidate > salePrice ? listCandidate : salePrice;
  const onSale = listPrice > salePrice;
  if (opts.saleOnly && !onSale) return { skip: "할인 아님" };

  const marketCountry = opts.marketCountry || CURRENCY_MARKET[currency] || null;
  const categoryText = `${mapping.category ? row[mapping.category] : ""} ${name}`;
  const category = detectCategory(categoryText, "apparel");
  const brandName = opts.brand || (mapping.brand ? String(row[mapping.brand] || "").trim() : "") || opts.shop;
  const url = mapping.url ? urls.safeHref(String(row[mapping.url] || "").trim()) : null;
  const image = mapping.image ? urls.safeImageUrl(String(row[mapping.image] || "").trim()) : null;
  const sku = mapping.sku && row[mapping.sku] ? String(row[mapping.sku]).trim() : String(index);

  return {
    item: {
      sourceId: opts.sourceId,
      productId: sku,
      variantId: null,
      sku,
      brand: brandName,
      brandId: brands.toBrandId(brandName),
      name,
      currency,
      salePrice,
      listPrice,
      onSale,
      offRate: onSale ? Math.round((1 - salePrice / listPrice) * 100) : 0,
      minPrice: salePrice,
      maxPrice: salePrice,
      priceVaries: false,
      availability,
      marketCountry,
      region: opts.region || CURRENCY_REGION[currency] || null,
      category,
      weightKg: DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default,
      sizes: mapping.size && row[mapping.size] ? String(row[mapping.size]) : "",
      color: mapping.color && row[mapping.color] ? String(row[mapping.color]) : "",
      imageUrls: image ? [image] : [],
      sourceShop: opts.shop,
      sourceUrl: url,
      warnings,
    },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  FIELD_ALIASES,
  CURRENCY_MARKET,
  CURRENCY_REGION,
  parseDelimited,
  detectDelimiter,
  parseXml,
  loadFeed,
  buildMapping,
  currencyFrom,
  detectCategory,
  toItem,
};
