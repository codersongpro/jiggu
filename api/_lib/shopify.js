// Shopify products.json 응답 → 앱 상품 형식 (서버/PC 공용)
//
// 이 어댑터는 "응답이 실제로 검증된 소스"에만 쓴다. 전 사이트 공통 계약이 아니다(리뷰 R01).
// 가격·정가·재고·사이즈·색상·SKU는 같은 variant에서만 가져온다(리뷰 R04).

const offers = require("../../web/shared/offers.js");
const money = require("../../web/shared/money.js");
const brands = require("../../web/shared/brands.js");

// 무게 실측치가 없을 때 쓰는 배송비 계산용 추정값 (관세·환율 수치가 아니라 cost.yaml 대상이 아니다)
const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };

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

function optionKey(product, re) {
  if (!Array.isArray(product.options)) return null;
  const idx = product.options.findIndex((o) => re.test(o.name || ""));
  return idx === 0 ? "option1" : idx === 1 ? "option2" : idx === 2 ? "option3" : null;
}

/**
 * Shopify 상품 하나 → 앱 상품(schema.js가 검증할 수 있는 형태).
 * @returns {object|null}
 */
function normalizeProduct(product, source) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (!variants.length) return null;

  const sizeKey = optionKey(product, /size|사이즈|サイズ/i);
  const colorKey = optionKey(product, /colou?r|색상|カラー/i);
  const warnings = [];

  const rawOffers = variants.map((v) => {
    const price = money.parseMoney(v.price, { currency: source.currency });
    const compare = money.parseMoney(v.compare_at_price, { currency: source.currency });
    if (price.value === null && v.price) warnings.push(`가격을 읽지 못함: ${v.price}`);
    return {
      variantId: v.id,
      sku: v.sku || null,
      price: price.value,
      compareAtPrice: compare.value,
      currency: price.currency || source.currency,
      availability: v.available,
      size: sizeKey ? v[sizeKey] : null,
      color: colorKey ? v[colorKey] : null,
      grams: v.grams,
    };
  });

  const summary = offers.summarizeOffers(rawOffers);
  if (summary.salePrice === null) return null;

  const category = detectCategory(product, source.category);
  const selected = summary.selectedOffer || {};
  const selectedRaw = rawOffers.find((o) => String(o.variantId) === String(selected.variantId));
  const grams = selectedRaw && selectedRaw.grams > 0 ? selectedRaw.grams : 0;
  const weightKg = grams > 0 ? grams / 1000 : DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default;

  // 멀티브랜드 편집숍은 사이트 이름과 실제 제조사 브랜드(vendor)가 다르다.
  const brandName = (product.vendor && String(product.vendor).trim()) || source.shopName;

  return {
    sourceId: source.sourceId,
    productId: String(product.id),
    variantId: selected.variantId || null,
    sku: selected.sku || String(product.id),
    brand: brandName,
    brandId: brands.toBrandId(brandName),
    name: product.title,
    currency: summary.currency || source.currency,
    salePrice: summary.salePrice,
    listPrice: summary.onSale ? summary.listPrice : summary.salePrice,
    onSale: summary.onSale,
    offRate: summary.offRate,
    minPrice: summary.minPrice,
    maxPrice: summary.maxPrice,
    priceVaries: summary.priceVaries,
    availability: summary.availability,
    marketCountry: source.marketCountry,
    region: source.region,
    locale: source.locale,
    category,
    weightKg,
    sizes: offers.availableSizes(rawOffers).join(" / "),
    color: selected.color || "",
    imageUrls: Array.isArray(product.images) ? product.images.slice(0, 8).map((img) => img.src) : [],
    sourceShop: source.shopName,
    sourceUrl: `${source.baseUrl}/products/${product.handle}`,
    warnings: warnings.concat(summary.warnings).slice(0, 5),
  };
}

module.exports = { normalizeProduct, detectCategory, DEFAULT_WEIGHT_KG };
