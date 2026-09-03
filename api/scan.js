// 스캔 API — targets.json에 등록된 Shopify 기반 브랜드몰들을 병렬로 조회해
// 세일 중인 상품만 뽑아 정리한다. 사이트 하나가 막혀도 나머지는 계속 진행한다.
//
// 이 세션은 외부 네트워크가 막혀 있어 실제 사이트 응답을 검증하지 못했다.
// Shopify 표준 스펙(https://{도메인}/products.json)대로 작성했으니
// 배포 후 실제로 스캔을 돌려 sitesFailed / errors를 확인할 것.

const targets = require("../config/targets.json");
const { loadConfig, landedCost } = require("./_lib/landedCost");

const FETCH_TIMEOUT_MS = 8000;
const PRODUCTS_PER_PAGE = 250; // Shopify products.json이 허용하는 최대 limit
const MAX_PAGES_PER_SITE = 4;  // 사이트당 최대 조회 페이지 (최대 1000개 상품까지 순회)
const MAX_ITEMS_PER_SITE = 25; // 사이트당 세일 상품 상위 N개만 (응답 크기 제한). 프론트는 20개씩 "다음" 버튼으로 나눠 보여준다

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

// 스캔 시점 실시간 환율. 키가 필요 없는 무료 API(유럽중앙은행 기반)를 쓴다.
// 실패하면 cost.yaml의 고정값을 그대로 쓴다 — cost.yaml 주석에도 "API 주입" 옵션이 이미 적혀 있었다.
async function fetchLiveFxRates() {
  const data = await fetchWithTimeout("https://api.frankfurter.dev/v1/latest?base=KRW&symbols=USD,EUR,JPY");
  const r = data.rates;
  if (!r || !r.USD || !r.EUR || !r.JPY) throw new Error("환율 응답 형식 이상");
  return { USD: 1 / r.USD, EUR: 1 / r.EUR, JPY: 1 / r.JPY };
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
  const inStock = variants.filter((v) => v.available && parseFloat(v.price) > 0);
  if (!inStock.length) return null;

  // 세일 아니어도(환율·기본가 자체가 싼 경우) 상품탭에서 찾을 수 있어야 하므로
  // 세일 variant가 없어도 걸러내지 않는다. onSale로 구분만 해서 넘긴다.
  const saleVariants = inStock.filter((v) => {
    const price = parseFloat(v.price);
    const compareAt = parseFloat(v.compare_at_price);
    return compareAt > 0 && compareAt > price;
  });
  const onSale = saleVariants.length > 0;
  const priceBasis = onSale ? saleVariants : inStock;

  const salePrice = Math.min(...priceBasis.map((v) => parseFloat(v.price)));
  const listPrice = onSale ? Math.max(...saleVariants.map((v) => parseFloat(v.compare_at_price))) : salePrice;

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
    onSale,
    offRate: onSale ? Math.round((1 - salePrice / listPrice) * 100) : 0,
  };
}

async function fetchAllProducts(base) {
  let all = [];
  for (let page = 1; page <= MAX_PAGES_PER_SITE; page++) {
    const url = `${base}/products.json?limit=${PRODUCTS_PER_PAGE}&page=${page}`;
    let data;
    try {
      data = await fetchWithTimeout(url);
    } catch (err) {
      if (page === 1) throw err; // 첫 페이지 실패는 사이트 전체 실패로 처리
      break; // 이후 페이지 실패는 그때까지 모은 상품으로 진행
    }
    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) break;
    all = all.concat(products);
    if (products.length < PRODUCTS_PER_PAGE) break; // 마지막 페이지
  }
  return all;
}

async function scanSite(site, cfg, mode, uncapped) {
  const base = `https://${site.domain}`;
  const products = await fetchAllProducts(base);

  const withCost = products
    .map((p) => normalizeProduct(p, site))
    .filter(Boolean)
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

  const onSaleItems = withCost.filter((it) => it.onSale).sort((a, b) => b.offRate - a.offRate);
  const regularItems = withCost.filter((it) => !it.onSale).sort((a, b) => a.cost.totalKrw - b.cost.totalKrw);

  // 브랜드를 지정해 찾아온 경우(?brand=)는 캡 없이 그 사이트 전체를 돌려준다 —
  // "이 브랜드에서 뭐가 있는지 전부 보고 싶다"는 요청이라 할인율/저가 우선순위로
  // 걸러내면 안 된다. 지정 없는 일반 스캔은 응답 크기 때문에 사이트당 상위 N개만 남긴다.
  if (uncapped) return [...onSaleItems, ...regularItems];

  const saleSlots = Math.ceil(MAX_ITEMS_PER_SITE * 0.7);
  const regularSlots = MAX_ITEMS_PER_SITE - saleSlots;
  return [...onSaleItems.slice(0, saleSlots), ...regularItems.slice(0, regularSlots)];
}

module.exports = async function handler(req, res) {
  const mode = req.query && (req.query.mode === "business" ? "business" : "proxy");
  const brandFilter = req.query && req.query.brand ? String(req.query.brand).trim() : "";
  const onlyPopular = req.query && req.query.onlyPopular === "1";
  const cfg = loadConfig();

  let fxSource = "cost.yaml 고정값";
  try {
    const liveFx = await fetchLiveFxRates();
    cfg.fx.base_rate = { ...cfg.fx.base_rate, ...liveFx };
    fxSource = "실시간(frankfurter.dev, ECB 기준)";
  } catch (e) {
    // 환율 API가 막히거나 실패하면 cost.yaml 고정값으로 계속 진행한다
  }

  const allSites = [...targets.sites, ...(targets.sites_multi_brand || [])];
  let sites = allSites.filter((s) => s.platform === "shopify");
  let uncapped = false;

  if (brandFilter) {
    // "확인" 버튼으로 특정 브랜드를 지정한 경우 — 그 브랜드가 나올 수 있는 사이트를
    // 전부 훑어서 합친다: ① 공식몰(지역별로 여러 개일 수 있다 — 예: Sandro/Sandro EU)
    // ② 멀티브랜드 편집숍(vendor로 이 브랜드가 섞여 있을 수 있다). 한 곳만 보면
    // 그 사이트가 막혀 있을 때 아예 결과가 안 나오니, 여러 사이트에서 모아 교차 확인한다.
    sites = [...sites, ...(targets.sites_multi_brand || []).filter((s) => s.platform === "shopify")];
    uncapped = true;
  } else if (onlyPopular) {
    // "Sale중" 탭 전용 — 대중적으로 잘 알려진 브랜드만 스캔해서 세일 신호의 노이즈를 줄인다.
    sites = sites.filter((s) => s.popular === true);
  }

  const results = await Promise.allSettled(
    sites.map((site) => scanSite(site, cfg, mode, uncapped))
  );

  let items = [];
  const errors = [];
  results.forEach((r, i) => {
    const site = sites[i];
    if (r.status === "fulfilled") {
      items.push(...r.value);
    } else {
      errors.push({ brand: site.brand, domain: site.domain, error: String(r.reason && r.reason.message || r.reason) });
    }
  });

  if (brandFilter) {
    // 여러 사이트를 합쳐서 긁어왔으니, 실제 상품 브랜드(vendor 우선 판별된 값)가
    // 지정한 브랜드와 일치하는 것만 남긴다. "Sandro EU"처럼 지역 접미사가 붙은
    // 사이트명도 잡히도록 접두어 일치까지 허용한다.
    const bf = brandFilter.toLowerCase();
    items = items.filter((it) => {
      const b = it.brand.toLowerCase();
      return b === bf || b.startsWith(bf + " ");
    });
  }

  items.sort((a, b) => b.offRate - a.offRate);

  // "Sale중" 탭 요약은 실제로 세일 중인 상품만 센다 — 정가 상품이 섞이면 세일 집계가 왜곡된다.
  const brandSummary = {};
  items.filter((it) => it.onSale).forEach((it) => {
    brandSummary[it.brand] = (brandSummary[it.brand] || 0) + 1;
  });

  res.status(200).json({
    scannedAt: new Date().toISOString(),
    mode,
    fxRates: { USD: cfg.fx.base_rate.USD, EUR: cfg.fx.base_rate.EUR, JPY: cfg.fx.base_rate.JPY },
    fxSource,
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
