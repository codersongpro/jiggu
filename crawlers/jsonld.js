// schema.org JSON-LD → 앱 상품 (순수 함수, 브라우저 없이 테스트 가능)
//
// 고친 것 (리뷰 R08)
//  - mainEntity가 배열이 아니라 객체인 경우, @graph, ProductGroup/hasVariant를 모두 본다.
//  - AggregateOffer의 lowPrice/highPrice는 '가격 범위'다. highPrice를 정가로 보고
//    할인율을 만들던 동작을 없앴다.
//  - 여러 Offer의 가격·통화·재고를 한 덩어리로 뭉개지 않고 옵션별로 보존한다.

const money = require("../web/shared/money.js");
const offersLib = require("../web/shared/offers.js");
const brands = require("../web/shared/brands.js");
const urls = require("../web/shared/urls.js");

const DEFAULT_WEIGHT_KG = { apparel: 0.8, shoes: 1.3, bag: 1.1, watch: 0.4, accessory: 0.4, default: 0.8 };
const CATEGORY_KEYWORDS = [
  { cat: "shoes", w: /shoe|sneaker|boot|loafer|sandal|heel|slipper|footwear/i },
  { cat: "bag", w: /\bbag\b|tote|backpack|clutch|wallet|pack\b|luggage/i },
  { cat: "watch", w: /watch/i },
  { cat: "accessory", w: /sunglass|jewelry|belt|scarf|\bhat\b|glove|beanie|sock/i },
];

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const typesOf = (node) => asArray(node && node["@type"]).map((t) => String(t).replace(/^.*[/#]/, ""));

/** JSON-LD 블록들에서 Product / ProductGroup 노드를 모두 찾는다 */
function findProducts(root) {
  const found = [];
  const seen = new Set();

  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);

    const types = typesOf(node);
    if (types.includes("Product") || types.includes("ProductGroup") || types.includes("ProductModel")) {
      found.push(node);
      // ProductGroup의 hasVariant는 여기서 함께 다루므로 더 내려가지 않는다
      return;
    }
    // @graph / mainEntity(객체·배열) / itemListElement / ItemList
    ["@graph", "mainEntity", "itemListElement", "about", "item"].forEach((key) => {
      if (node[key]) visit(node[key], depth + 1);
    });
  };

  visit(root, 0);
  return found;
}

/** <script type="application/ld+json"> 문자열 배열 → Product 노드 목록 */
function parseBlocks(blocks) {
  const products = [];
  const warnings = [];
  asArray(blocks).forEach((raw, i) => {
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch (e) {
      warnings.push(`JSON-LD 블록 ${i}를 읽지 못함`);
      return;
    }
    products.push(...findProducts(parsed));
  });
  return { products, warnings };
}

function textOf(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === "object") return textOf(v.name || v["@value"] || v.value || "");
  return "";
}

function imagesOf(node) {
  return asArray(node.image)
    .map((img) => (typeof img === "string" ? img : img && (img.url || img.contentUrl)))
    .map((u) => urls.safeImageUrl(u))
    .filter(Boolean)
    .slice(0, 8);
}

/** Offer(또는 AggregateOffer) 하나 → 정규화 입력 */
function readOffer(offer, ctx) {
  const types = typesOf(offer);
  const currencyRaw = textOf(offer.priceCurrency) || null;
  const base = {
    currency: currencyRaw || ctx.currencyHint || null,
    availability: offer.availability !== undefined ? offer.availability : offer.inventoryLevel,
    sku: textOf(offer.sku) || ctx.sku || null,
    url: urls.safeHref(textOf(offer.url)) || null,
    size: ctx.size || null,
    color: ctx.color || null,
    variantId: ctx.variantId || textOf(offer.sku) || null,
  };

  if (types.includes("AggregateOffer")) {
    const low = money.parseMoney(offer.lowPrice, { currency: base.currency });
    const high = money.parseMoney(offer.highPrice, { currency: base.currency });
    // 내부에 개별 Offer가 들어 있으면 그쪽이 정확하다
    const inner = asArray(offer.offers).flatMap((o) => readOffer(o, ctx));
    if (inner.length) return inner;
    if (low.value === null) return [];
    return [
      Object.assign({}, base, {
        priceRange: true,
        minPrice: low.value,
        maxPrice: high.value !== null ? high.value : low.value,
        price: null,
        currency: low.currency || base.currency,
      }),
    ];
  }

  const price = money.parseMoney(offer.price !== undefined ? offer.price : offer.priceSpecification, {
    currency: base.currency,
  });
  let value = price.value;
  if (value === null && offer.priceSpecification) {
    const spec = asArray(offer.priceSpecification)[0] || {};
    const p = money.parseMoney(spec.price, { currency: textOf(spec.priceCurrency) || base.currency });
    value = p.value;
    if (p.currency) base.currency = p.currency;
  }
  if (value === null) return [];

  // 같은 Offer 안의 정가 표기 (listPrice / priceSpecification의 ListPrice)
  let compareAt = null;
  const listSpec = asArray(offer.priceSpecification).find((s) => /list|strikethrough|previous|original/i.test(textOf(s && s["@type"]) + textOf(s && s.name)));
  if (listSpec) compareAt = money.parseMoney(listSpec.price, { currency: base.currency }).value;
  if (compareAt === null && offer.listPrice !== undefined) compareAt = money.parseMoney(offer.listPrice, { currency: base.currency }).value;

  return [Object.assign({}, base, { price: value, compareAtPrice: compareAt, currency: price.currency || base.currency })];
}

function variantOptions(node) {
  // 변형 상품이 갖는 사이즈·색상 표기
  const size = textOf(node.size) || textOf(node.additionalProperty && asArray(node.additionalProperty).find((p) => /size/i.test(textOf(p.name)))?.value);
  const color = textOf(node.color);
  return { size: size || null, color: color || null };
}

function detectCategory(text, fallback) {
  const hit = CATEGORY_KEYWORDS.find((c) => c.w.test(text));
  return hit ? hit.cat : fallback || "apparel";
}

/**
 * Product/ProductGroup 노드 → 앱 상품
 * @param {object} node
 * @param {{url:string, source:object}} ctx
 */
function toItem(node, ctx) {
  const source = ctx.source || {};
  const name = textOf(node.name);
  if (!name) return { error: "상품명(name)이 없음" };

  const sku = textOf(node.sku) || textOf(node.mpn) || textOf(node.productID) || null;
  const own = variantOptions(node);
  const rawOffers = [];

  // ProductGroup은 hasVariant 안에 옵션별 Product가 들어 있다
  const variants = asArray(node.hasVariant);
  if (variants.length) {
    variants.forEach((v, i) => {
      const opt = variantOptions(v);
      const vSku = textOf(v.sku) || textOf(v.productID) || `${sku || "v"}-${i}`;
      asArray(v.offers).forEach((o) => {
        rawOffers.push(
          ...readOffer(o, {
            currencyHint: source.currency,
            sku: vSku,
            variantId: vSku,
            size: opt.size || own.size,
            color: opt.color || own.color,
          })
        );
      });
    });
  }
  asArray(node.offers).forEach((o, i) => {
    rawOffers.push(
      ...readOffer(o, {
        currencyHint: source.currency,
        sku,
        variantId: sku ? `${sku}-${i}` : String(i),
        size: own.size,
        color: own.color,
      })
    );
  });

  if (!rawOffers.length) return { error: "가격(offers)을 찾지 못함" };

  const summary = offersLib.summarizeOffers(rawOffers);
  if (summary.salePrice === null) return { error: "가격을 읽지 못함" };
  if (!summary.currency) return { error: "통화를 확인할 수 없음" };

  const brandName = textOf(node.brand) || source.shopName || "";
  const canonicalUrl = urls.safeHref(textOf(node.url)) || urls.canonicalizeUrl(ctx.url);
  const productId = urls.productIdFromUrl(canonicalUrl || ctx.url, source.productIdPattern) || sku || canonicalUrl;
  const category = detectCategory(`${textOf(node.category)} ${name}`, source.category);
  const selected = summary.selectedOffer || {};

  return {
    item: {
      sourceId: source.sourceId,
      productId: String(productId),
      variantId: selected.variantId || null,
      sku: selected.sku || sku,
      brand: brandName,
      brandId: brands.toBrandId(brandName),
      name,
      currency: summary.currency,
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
      weightKg: DEFAULT_WEIGHT_KG[category] || DEFAULT_WEIGHT_KG.default,
      sizes: offersLib.availableSizes(rawOffers).join(" / "),
      color: selected.color || own.color || "",
      imageUrls: imagesOf(node),
      sourceShop: source.shopName,
      sourceUrl: canonicalUrl || ctx.url,
      warnings: summary.warnings.slice(0, 5),
    },
  };
}

/**
 * 페이지에서 읽은 JSON-LD 블록들 → 상품 하나
 * @param {string[]} blocks
 * @param {{url:string, source:object}} ctx
 */
function extractProduct(blocks, ctx) {
  const { products, warnings } = parseBlocks(blocks);
  if (!products.length) return { error: "JSON-LD Product를 찾지 못함", warnings };

  // 여러 Product가 있으면(추천 상품 등) 현재 URL과 일치하는 것을 먼저 고른다
  const canonical = urls.canonicalizeUrl(ctx.url);
  const scored = products
    .map((p) => {
      const u = urls.canonicalizeUrl(textOf(p.url), ctx.url);
      return { node: p, match: u && canonical && u === canonical ? 2 : asArray(p.offers).length || asArray(p.hasVariant).length ? 1 : 0 };
    })
    .sort((a, b) => b.match - a.match);

  for (const cand of scored) {
    const res = toItem(cand.node, ctx);
    if (res.item) return { item: res.item, warnings };
  }
  return { error: toItem(scored[0].node, ctx).error || "상품을 만들지 못함", warnings };
}

module.exports = { findProducts, parseBlocks, readOffer, toItem, extractProduct, detectCategory, DEFAULT_WEIGHT_KG };
