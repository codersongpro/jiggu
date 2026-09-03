#!/usr/bin/env node
// 로컬 브라우저 크롤러 — Shopify products.json이 없는 사이트(REI, 백화점형 편집숍 등)를 위한 보조 수집기.
//
// 왜 로컬인가: Vercel 서버리스에서는 브라우저를 띄울 수 없고(용량·실행시간 제한), 서버 IP로
// 나가는 요청은 이미 여러 사이트에서 막히는 게 확인됐다. 그래서 사용자 PC에서 직접 돌린다.
//
// 이 스크립트가 하지 않는 것: 봇 탐지 우회. TLS 지문 위장, Stealth 플러그인, 주거용 프록시,
// 캡차 자동 풀이는 쓰지 않는다. 403/503/캡차가 나오면 그 사이트는 sites.json에서 빼는 게 원칙이다.
//
// 가격 추출 방식: 사이트마다 다른 CSS 클래스명을 추측하는 대신, 검색엔진 노출용으로 대부분의
// 이커머스가 심어두는 표준 구조화 데이터(schema.org JSON-LD)를 읽는다. 플랫폼이 뭐든 상관없다.
//
// 실행:
//   npm install playwright && npx playwright install chromium
//   node scripts/local-crawler/crawl.js            (구매대행 모드)
//   node scripts/local-crawler/crawl.js --business (사업자 사입 모드)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadConfig, landedCost } = require("../../api/_lib/landedCost");

const sitesConfig = require("./sites.json");

// CLAUDE.md 수집 규칙: 도메인당 동시 1, 요청 간 2~5초 랜덤 대기
const DELAY_MS = [2000, 5000];
const MAX_PRODUCTS_PER_SITE = 40;
const NAV_TIMEOUT_MS = 25000;

// 무게 실측치가 없을 때 쓰는 배송비 계산용 추정값. api/scan.js와 같은 값을 쓴다.
const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };

// linkPattern을 따로 지정하지 않은 사이트에 쓰는 기본 상품 링크 판별 규칙
const DEFAULT_LINK_PATTERN = /\/(product|products|p|dp|item|shop)\//;

const CATEGORY_KEYWORDS = [
  { cat: "shoes", w: /shoe|sneaker|boot|loafer|sandal|heel/i },
  { cat: "bag", w: /\bbag\b|tote|backpack|clutch|wallet/i },
  { cat: "watch", w: /watch/i },
  { cat: "accessory", w: /sunglass|jewelry|belt|scarf|\bhat\b|glove|beanie/i },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]);

function detectCategory(text, fallback) {
  const hit = CATEGORY_KEYWORDS.find((c) => c.w.test(text));
  return hit ? hit.cat : fallback;
}

async function collectProductLinks(page, site) {
  const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  const pattern = site.linkPattern ? new RegExp(site.linkPattern) : DEFAULT_LINK_PATTERN;
  const seen = new Set();
  const links = [];
  for (const href of hrefs) {
    if (!href || !pattern.test(href)) continue;
    const abs = href.startsWith("http") ? href : `https://${site.domain}${href.startsWith("/") ? "" : "/"}${href}`;
    if (!abs.includes(site.domain) || seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
    if (links.length >= MAX_PRODUCTS_PER_SITE) break;
  }
  return links;
}

// 페이지 안의 JSON-LD 블록 중 schema.org Product를 찾아 돌려준다.
function findProduct(node) {
  if (!node || typeof node !== "object") return null;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (types.includes("Product")) return node;
  const nested = node["@graph"] || node.mainEntity || node.itemListElement;
  if (Array.isArray(nested)) {
    for (const child of nested) {
      const found = findProduct(child.item || child);
      if (found) return found;
    }
  }
  return null;
}

async function extractProduct(page) {
  const blocks = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
    nodes.map((n) => n.textContent)
  );
  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 깨진 JSON-LD 블록은 건너뛴다
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      const product = findProduct(entry);
      if (product) return product;
    }
  }
  return null;
}

function toItem(product, url, site) {
  const offersRaw = product.offers;
  const offers = Array.isArray(offersRaw) ? offersRaw : [offersRaw].filter(Boolean);
  const prices = offers.map((o) => parseFloat(o && o.price)).filter((p) => p > 0);

  // AggregateOffer는 price 대신 lowPrice/highPrice를 쓴다
  const aggregate = offers.find((o) => o && (o.lowPrice || o.highPrice));
  const low = aggregate ? parseFloat(aggregate.lowPrice) : NaN;
  const high = aggregate ? parseFloat(aggregate.highPrice) : NaN;

  const salePrice = prices.length ? Math.min(...prices) : low;
  if (!(salePrice > 0)) return null;

  // JSON-LD에는 "할인 전 정가" 표준 필드가 없다. AggregateOffer의 highPrice가 있으면
  // 그걸 정가로 보되, 사이즈별 가격차일 수도 있으므로 확신할 수 없다 — onSale 판정은 보수적으로 한다.
  const listPrice = high > salePrice ? high : salePrice;
  const onSale = listPrice > salePrice;

  const name = product.name || "";
  const brandField = product.brand;
  const brand = (brandField && (brandField.name || (typeof brandField === "string" ? brandField : ""))) || site.brand;
  const category = detectCategory(`${product.category || ""} ${name}`, site.defaultCategory);
  const images = Array.isArray(product.image) ? product.image : [product.image].filter(Boolean);
  const currency = (offers.find((o) => o && o.priceCurrency) || {}).priceCurrency || site.currency;

  return {
    id: `${site.domain}:${url}`,
    brand,
    name,
    sku: product.sku || product.mpn || url,
    listPrice,
    salePrice,
    currency,
    region: site.region,
    category,
    weightKg: DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default,
    sizes: "",
    color: "",
    imageUrls: images.slice(0, 8),
    sourceShop: site.brand,
    sourceUrl: url,
    onSale,
    offRate: onSale ? Math.round((1 - salePrice / listPrice) * 100) : 0,
  };
}

async function crawlSite(context, site) {
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const items = [];

  try {
    for (const listingUrl of site.listingUrls || []) {
      await page.goto(listingUrl, { waitUntil: "domcontentloaded" });
      const links = await collectProductLinks(page, site);
      console.log(`[${site.brand}] ${listingUrl} → 상품 링크 ${links.length}개`);

      for (const url of links) {
        await sleep(randomDelay());
        try {
          const res = await page.goto(url, { waitUntil: "domcontentloaded" });
          if (res && res.status() >= 400) {
            console.warn(`[${site.brand}] ${res.status()} — 이 사이트는 차단됐을 수 있다. 계속 실패하면 sites.json에서 빼라`);
            break;
          }
          const product = await extractProduct(page);
          if (!product) continue; // JSON-LD가 없는 페이지는 건너뛴다
          const item = toItem(product, url, site);
          if (item) items.push(item);
        } catch (err) {
          console.warn(`[${site.brand}] ${url} 실패: ${err.message}`);
        }
      }
    }
  } finally {
    await page.close();
  }

  return items;
}

(async () => {
  const mode = process.argv.includes("--business") ? "business" : "proxy";
  const cfg = loadConfig();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });

  let items = [];
  for (const site of sitesConfig.sites) {
    if (!site.listingUrls || !site.listingUrls.length) {
      console.log(`[${site.brand}] listingUrls 비어 있음 — 건너뜀`);
      continue;
    }
    try {
      items = items.concat(await crawlSite(context, site));
    } catch (err) {
      console.warn(`[${site.brand}] 사이트 전체 실패: ${err.message}`);
    }
  }

  await browser.close();

  const withCost = items.map((item) => ({
    ...item,
    cost: landedCost(
      cfg,
      {
        price: item.salePrice,
        currency: item.currency,
        region: item.region,
        category: item.category,
        weight_kg: item.weightKg,
      },
      mode
    ),
  }));

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `local-scan-${Date.now()}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ scannedAt: new Date().toISOString(), mode, itemCount: withCost.length, items: withCost }, null, 2)
  );

  console.log(`\n완료: ${withCost.length}개 → ${outFile}`);
  console.log("이 파일을 앱의 설정 탭 > '로컬 크롤링 결과 가져오기'에서 열면 상품 목록에 합쳐진다.");
})();
