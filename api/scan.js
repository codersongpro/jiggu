// 스캔 API — targets.json에 등록된 Shopify 기반 브랜드몰들을 병렬로 조회해
// 세일 중인 상품만 뽑아 정리한다. 사이트 하나가 막혀도 나머지는 계속 진행한다.
//
// 이 세션은 외부 네트워크가 막혀 있어 실제 사이트 응답을 검증하지 못했다.
// Shopify 표준 스펙(https://{도메인}/products.json)대로 작성했으니
// 배포 후 실제로 스캔을 돌려 sitesFailed / errors를 확인할 것.

const targets = require("../config/targets.json");
const { loadConfig, landedCost } = require("./_lib/landedCost");

const FETCH_TIMEOUT_MS = 8000;
const PRODUCTS_PER_SITE = 100;
const MAX_ITEMS_PER_SITE = 12; // 사이트당 세일 상품 상위 N개만 (응답 크기 제한)

// 무게 실측치가 없을 때 쓰는 카테고리 평균 추정값. 관세·환율 수치가 아니라
// 배송비 계산용 보정값이라 cost.yaml이 아니라 여기서 관리한다.
const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; family-sourcing-radar/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractSizeOptionIndex(product) {
  if (!Array.isArray(product.options)) return null;
  const idx = product.options.findIndex((o) => /size|사이즈/i.test(o.name || ""));
  return idx >= 0 ? idx : null;
}

// product_type/제목으로 카테고리를 추정한다. 멀티브랜드 편집숍은 한 사이트 안에
// 의류·신발·가방이 섞여 있어 site.category 하나로 고정하면 관세율(8%/13%)이 틀어진다.
const CATEGORY_KEYWORDS = [
  { cat: "shoes", w: /shoe|sneaker|boot|loafer|sandal|heel|slipper|mule|espadrille/i },
  { cat: "bag", w: /\bbag\b|tote|backpack|clutch|wallet|pouch|handbag/i },
  { cat: "watch", w: /watch/i },
  { cat: "accessory", w: /sunglass|jewelry|jewellery|belt|scarf|\bhat\b|glove|earring|necklace/i },
];
function detectCategory(product, fallback) {
  const hay = `${product.product_type || ""} ${product.title || ""}`;
  const hit = CATEGORY_KEYWORDS.find((c) => c.w.test(hay));
  return hit ? hit.cat : fallback;
}

function normalizeProduct(product, site) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const onSale = variants.filter((v) => {
    const price = parseFloat(v.price);
    const compareAt = parseFloat(v.compare_at_price);
    return compareAt > 0 && price > 0 && compareAt > price;
  });
  if (!onSale.length) return null;

  const salePrice = Math.min(...onSale.map((v) => parseFloat(v.price)));
  const listPrice = Math.max(...onSale.map((v) => parseFloat(v.compare_at_price)));
  const inStock = onSale.filter((v) => v.available);
  if (!inStock.length) return null;

  const sizeIdx = extractSizeOptionIndex(product);
  const sizeKey = sizeIdx === 0 ? "option1" : sizeIdx === 1 ? "option2" : sizeIdx === 2 ? "option3" : null;
  const sizes = sizeKey
    ? [...new Set(inStock.map((v) => v[sizeKey]).filter(Boolean))]
    : [];

  const category = detectCategory(product, site.category);
  const weightGrams = inStock[0].grams;
  const weightKg = weightGrams > 0 ? weightGrams / 1000 : DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default;

  const colorIdx = Array.isArray(product.options)
    ? product.options.findIndex((o) => /colou?r|색상/i.test(o.name || ""))
    : -1;
  const colorKey = colorIdx === 0 ? "option1" : colorIdx === 1 ? "option2" : colorIdx === 2 ? "option3" : null;
  const color = colorKey ? inStock[0][colorKey] || "" : "";

  // 멀티브랜드 편집숍은 사이트 이름(site.brand)과 실제 제조사 브랜드(vendor)가 다르다.
  // Shopify는 상품마다 vendor 필드로 실제 브랜드를 알려주므로, 있으면 그걸 우선한다.
  // 브랜드 공식몰은 보통 vendor === site.brand라 이 로직으로도 그대로 맞는다.
  const brand = (product.vendor && product.vendor.trim()) || site.brand;

  return {
    id: `${site.domain}:${product.id}`,
    brand,
    name: product.title,
    sku: inStock[0].sku || String(product.id),
    listPrice,
    salePrice,
    currency: site.currency,
    region: site.region,
    category,
    weightKg,
    sizes: sizes.join(" / "),
    color,
    imageUrls: Array.isArray(product.images) ? product.images.slice(0, 8).map((img) => img.src) : [],
    sourceShop: site.brand, // 구입처(사이트) 이름 — brand(실제 제조사)와 다를 수 있다
    sourceUrl: `https://${site.domain}/products/${product.handle}`,
    offRate: Math.round((1 - salePrice / listPrice) * 100),
  };
}

async function scanSite(site, cfg, mode) {
  const base = `https://${site.domain}`;
  const url = `${base}/products.json?limit=${PRODUCTS_PER_SITE}`;
  const data = await fetchWithTimeout(url);
  const products = Array.isArray(data.products) ? data.products : [];

  const items = products
    .map((p) => normalizeProduct(p, site))
    .filter(Boolean)
    .sort((a, b) => b.offRate - a.offRate)
    .slice(0, MAX_ITEMS_PER_SITE)
    .map((item) => {
      const cost = landedCost(
        cfg,
        {
          price: item.salePrice,
          currency: item.currency,
          region: item.region,
          category: item.category,
          weight_kg: item.weightKg,
        },
        mode
      );
      return { ...item, cost };
    });

  return items;
}

module.exports = async function handler(req, res) {
  const mode = req.query && (req.query.mode === "business" ? "business" : "proxy");
  const cfg = loadConfig();
  const allSites = [...targets.sites, ...(targets.sites_multi_brand || [])];
  const sites = allSites.filter((s) => s.platform === "shopify");

  const results = await Promise.allSettled(
    sites.map((site) => scanSite(site, cfg, mode))
  );

  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    const site = sites[i];
    if (r.status === "fulfilled") {
      items.push(...r.value);
    } else {
      errors.push({ brand: site.brand, domain: site.domain, error: String(r.reason && r.reason.message || r.reason) });
    }
  });

  items.sort((a, b) => b.offRate - a.offRate);

  const brandSummary = {};
  items.forEach((it) => {
    brandSummary[it.brand] = (brandSummary[it.brand] || 0) + 1;
  });

  res.status(200).json({
    scannedAt: new Date().toISOString(),
    mode,
    sitesTotal: sites.length,
    sitesOk: sites.length - errors.length,
    sitesFailed: errors.length,
    itemCount: items.length,
    brandSummary,
    items,
    errors,
  });
};

// 테스트용 노출 (Vercel은 module.exports가 함수면 그대로 핸들러로 쓰므로 영향 없다)
module.exports.normalizeProduct = normalizeProduct;
module.exports.scanSite = scanSite;
