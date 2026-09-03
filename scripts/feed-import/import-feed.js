#!/usr/bin/env node
// 어필리에이트 상품 피드 → 앱 상품 목록 변환기
//
// 코치·마이클코어스·케이트스페이드·랄프로렌처럼 서버 요청을 차단하는 브랜드의 가격 데이터를
// 얻는 정공법이다. 스크래핑이 아니라 브랜드가 제휴사에 공식 제공하는 상품 피드를 읽는다.
// 차단당할 일이 없고, 정가/할인가/SKU/재고가 정리돼 있어 데이터 품질도 스크래핑보다 낫다.
//
// 네트워크마다 컬럼명이 제각각이라(CJ / Rakuten / Awin / Impact / Google Shopping XML)
// 흔히 쓰이는 이름들을 모아 자동으로 맞춘다. 못 맞추면 --map 옵션으로 직접 지정한다.
//
// 실행:
//   node scripts/feed-import/import-feed.js <피드파일> [옵션]
//
//   --brand "Coach"     피드에 브랜드 컬럼이 없을 때 브랜드명을 강제 지정
//   --shop "코치 (제휴피드)"  구입처 표시 이름 (기본: 파일명)
//   --region US|EU|JP   통화로 자동 판별되지만 직접 지정할 수도 있다
//   --sale-only         정가 대비 할인된 상품만 남긴다
//   --business          사업자 사입 모드로 원가 계산 (기본: 구매대행)
//   --limit 500         최대 상품 수 (기본 1000)
//   --map name=제목,salePrice=판매가   컬럼 직접 지정 (자동 인식 실패 시)
//
// 결과: scripts/feed-import/output/feed-<타임스탬프>.json
//       → 앱 설정 탭 > '로컬 크롤링 결과 가져오기'에서 열면 상품 탭에 합쳐진다.

const fs = require("fs");
const path = require("path");
const { loadConfig, landedCost } = require("../../api/_lib/landedCost");

const DEFAULT_LIMIT = 1000;
const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };

// 통화 → 지역. cost.yaml이 US/EU/JP만 다루므로 그 외 통화(GBP 등)는 처리하지 않는다.
const CURRENCY_REGION = { USD: "US", EUR: "EU", JPY: "JP" };

// 네트워크별 컬럼명 후보. 소문자·공백/언더바/하이픈 제거 후 비교한다.
const FIELD_ALIASES = {
  name: ["name", "title", "productname", "product", "gtitle"],
  brand: ["brand", "manufacturer", "brandname", "gbrand", "manufacturername"],
  sku: ["sku", "gid", "productid", "mpn", "gmpn", "partnumber", "id", "merchantsku"],
  listPrice: ["retailprice", "regularprice", "listprice", "msrp", "rrp", "originalprice", "gprice", "price"],
  salePrice: ["saleprice", "gsaleprice", "discountprice", "currentprice", "specialprice", "price"],
  currency: ["currency", "currencycode", "pricecurrency", "gpricecurrency"],
  url: ["link", "glink", "buyurl", "producturl", "clickurl", "awdeeplink", "destinationurl", "url", "trackinglink"],
  image: ["imageurl", "gimagelink", "image", "largeimage", "merchantimageurl", "awimageurl", "imagelink", "mainimage"],
  category: ["category", "producttype", "gproducttype", "primarycategory", "ggoogleproductcategory", "categoryname"],
  availability: ["availability", "instock", "stockavailability", "gavailability"],
};

const CATEGORY_KEYWORDS = [
  { cat: "shoes", w: /shoe|sneaker|boot|loafer|sandal|heel|pump|slipper/i },
  { cat: "bag", w: /\bbag\b|tote|backpack|clutch|wallet|purse|handbag|satchel|crossbody/i },
  { cat: "watch", w: /watch/i },
  { cat: "accessory", w: /sunglass|jewel|belt|scarf|\bhat\b|glove|earring|necklace|bracelet|ring\b/i },
];

const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-:]/g, "");

function parseArgs(argv) {
  const args = { file: null, flags: {}, map: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!args.file) args.file = a;
      continue;
    }
    const key = a.slice(2);
    if (["sale-only", "business"].includes(key)) {
      args.flags[key] = true;
      continue;
    }
    const value = argv[++i];
    if (key === "map") {
      value.split(",").forEach((pair) => {
        const [field, column] = pair.split("=");
        if (field && column) args.map[field.trim()] = column.trim();
      });
    } else {
      args.flags[key] = value;
    }
  }
  return args;
}

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

// ---------- XML 피드 (Google Shopping / RSS 형식) ----------
// 네트워크가 기계적으로 생성하는 형식이라 태그 구조가 일정하다.
function parseXml(text) {
  const itemTag = /<(item|entry|product)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const rows = [];
  let match;
  while ((match = itemTag.exec(text))) {
    const body = match[2];
    const row = {};
    const tag = /<([\w:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let t;
    while ((t = tag.exec(body))) {
      const value = t[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
      if (value && !row[t[1]]) row[t[1]] = value;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

function loadFeed(file) {
  const text = fs.readFileSync(file, "utf-8");
  if (/^\s*<\?xml|^\s*<rss|^\s*<feed/i.test(text)) return { rows: parseXml(text), format: "XML" };
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : 500);
  const delimiter = detectDelimiter(firstLine);
  return { rows: parseDelimited(text, delimiter), format: delimiter === "\t" ? "TSV" : delimiter === "|" ? "PIPE" : "CSV" };
}

// ---------- 컬럼 매핑 ----------
function buildMapping(sampleRow, overrides) {
  const columns = Object.keys(sampleRow);
  const byNorm = new Map(columns.map((c) => [norm(c), c]));
  const mapping = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (overrides[field]) { mapping[field] = overrides[field]; continue; }
    for (const alias of aliases) {
      if (byNorm.has(alias)) { mapping[field] = byNorm.get(alias); break; }
    }
  }
  return mapping;
}

// "$1,299.00" / "1299.00 USD" / "1.299,00" 같은 값에서 숫자만 뽑는다.
function toNumber(raw) {
  if (raw === undefined || raw === null) return NaN;
  let s = String(raw).replace(/[^\d.,]/g, "");
  if (!s) return NaN;
  // 마지막 구분자가 소수점이라고 보고 나머지는 천단위 구분자로 처리
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  return parseFloat(s);
}

function currencyFrom(row, mapping, fallback) {
  // 피드에 통화가 명시돼 있으면 무조건 그 값을 쓴다. 지원하지 않는 통화(GBP 등)라도
  // 그대로 돌려줘야 상위에서 건너뛴다 — USD로 잘못 폴백하면 원가가 통째로 틀어진다.
  const explicit = mapping.currency ? String(row[mapping.currency] || "").trim().toUpperCase() : "";
  if (explicit) return explicit;
  // "1299.00 USD"처럼 가격 필드에 통화가 붙어 오는 피드도 있다
  const priceRaw = String(row[mapping.salePrice] || row[mapping.listPrice] || "");
  const inline = priceRaw.match(/\b(USD|EUR|JPY)\b/i);
  if (inline) return inline[1].toUpperCase();
  if (/[$]/.test(priceRaw)) return "USD";
  if (/€/.test(priceRaw)) return "EUR";
  if (/¥|円/.test(priceRaw)) return "JPY";
  return fallback;
}

function detectCategory(text, fallback) {
  const hit = CATEGORY_KEYWORDS.find((c) => c.w.test(text));
  return hit ? hit.cat : fallback;
}

function isAvailable(row, mapping) {
  if (!mapping.availability) return true; // 재고 컬럼이 없으면 판단하지 않는다
  const v = norm(row[mapping.availability]);
  if (!v) return true;
  return !/outofstock|no|false|0|discontinued|unavailable/.test(v);
}

function toItem(row, mapping, opts, index) {
  const name = mapping.name ? String(row[mapping.name] || "").trim() : "";
  if (!name) return null;
  if (!isAvailable(row, mapping)) return null;

  const currency = currencyFrom(row, mapping, opts.currencyFallback);
  const region = opts.region || CURRENCY_REGION[currency];
  if (!region) return null; // cost.yaml이 다루지 않는 통화(GBP 등)는 건너뛴다

  // 같은 컬럼이 정가/할인가 양쪽 후보에 걸릴 수 있다(피드에 price 하나만 있는 경우).
  // 그때는 할인 정보가 없는 것으로 보고 정가 = 판매가로 둔다.
  const listRaw = mapping.listPrice ? toNumber(row[mapping.listPrice]) : NaN;
  const saleRaw = mapping.salePrice ? toNumber(row[mapping.salePrice]) : NaN;
  const sameColumn = mapping.listPrice === mapping.salePrice;

  const salePrice = saleRaw > 0 ? saleRaw : listRaw;
  const listPrice = !sameColumn && listRaw > salePrice ? listRaw : salePrice;
  if (!(salePrice > 0)) return null;

  const onSale = listPrice > salePrice;
  if (opts.saleOnly && !onSale) return null;

  const categoryText = `${mapping.category ? row[mapping.category] : ""} ${name}`;
  const category = detectCategory(categoryText, "apparel");
  const brand = opts.brand || (mapping.brand ? String(row[mapping.brand] || "").trim() : "") || opts.shop;
  const url = mapping.url ? String(row[mapping.url] || "").trim() : "";
  const image = mapping.image ? String(row[mapping.image] || "").trim() : "";

  return {
    id: `feed:${opts.shop}:${(mapping.sku && row[mapping.sku]) || index}`,
    brand,
    name,
    sku: (mapping.sku && String(row[mapping.sku]).trim()) || String(index),
    listPrice,
    salePrice,
    currency,
    region,
    category,
    weightKg: DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default,
    sizes: "",
    color: "",
    imageUrls: image ? [image] : [],
    sourceShop: opts.shop,
    sourceUrl: url,
    onSale,
    offRate: onSale ? Math.round((1 - salePrice / listPrice) * 100) : 0,
  };
}

// ---------- 실행 ----------
const args = parseArgs(process.argv);
if (!args.file) {
  console.error("사용법: node scripts/feed-import/import-feed.js <피드파일> [--brand \"Coach\"] [--sale-only]");
  console.error("자세한 옵션은 scripts/feed-import/README.md 참고");
  process.exit(1);
}
if (!fs.existsSync(args.file)) {
  console.error(`파일을 찾을 수 없습니다: ${args.file}`);
  process.exit(1);
}

const { rows, format } = loadFeed(args.file);
if (!rows.length) {
  console.error("피드에서 상품 행을 하나도 읽지 못했습니다. 파일 형식을 확인하세요.");
  process.exit(1);
}

const mapping = buildMapping(rows[0], args.map);
const missing = ["name", "salePrice"].filter((f) => !mapping[f]);

console.log(`형식: ${format} · 행 ${rows.length}개`);
console.log("컬럼 매핑:");
Object.entries(FIELD_ALIASES).forEach(([field]) => {
  console.log(`  ${field.padEnd(12)} → ${mapping[field] || "(못 찾음)"}`);
});

if (missing.length) {
  console.error(`\n필수 컬럼을 못 찾았습니다: ${missing.join(", ")}`);
  console.error(`피드의 실제 컬럼: ${Object.keys(rows[0]).join(", ")}`);
  console.error(`--map 옵션으로 직접 지정하세요. 예: --map "name=제목,salePrice=판매가"`);
  process.exit(1);
}

const mode = args.flags.business ? "business" : "proxy";
const opts = {
  brand: args.flags.brand || "",
  shop: args.flags.shop || path.basename(args.file).replace(/\.[^.]+$/, ""),
  region: args.flags.region || "",
  saleOnly: !!args.flags["sale-only"],
  currencyFallback: "USD",
};
const limit = parseInt(args.flags.limit, 10) || DEFAULT_LIMIT;

const cfg = loadConfig();
const items = [];
let skipped = 0;
for (let i = 0; i < rows.length && items.length < limit; i++) {
  const item = toItem(rows[i], mapping, opts, i);
  if (!item) { skipped++; continue; }
  items.push({
    ...item,
    cost: landedCost(
      cfg,
      { price: item.salePrice, currency: item.currency, region: item.region, category: item.category, weight_kg: item.weightKg },
      mode
    ),
  });
}

const outDir = path.join(__dirname, "output");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `feed-${Date.now()}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify({ scannedAt: new Date().toISOString(), mode, source: "affiliate-feed", itemCount: items.length, items }, null, 2)
);

console.log(`\n변환 완료: ${items.length}건 (건너뜀 ${skipped}건) → ${outFile}`);
console.log("앱 설정 탭 > '로컬 크롤링 결과 가져오기'에서 이 파일을 열면 상품 탭에 합쳐집니다.");
