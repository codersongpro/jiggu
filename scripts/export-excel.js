#!/usr/bin/env node
// 수집 결과 JSON → 엑셀(.xlsx) 정리
//
// PC 수집기(scripts/local-crawler)와 피드 변환기(scripts/feed-import)가 만든 JSON을
// 그대로 읽어 엑셀 한 파일로 만든다. 여러 파일을 한 번에 넣으면 같은 병합 규칙
// (sourceId + 상품 + variant 키)으로 합쳐서 하나의 표로 정리한다.
//
// 원가는 파일에 들어 있는 값을 그대로 쓰지 않고 지금 config/cost.yaml 기준으로 다시
// 계산한다 — 환율이나 통관 모드를 바꾸면 엑셀도 그 기준으로 나온다.
// 세금·배대지 조건이 검증되지 않은 시장(예: 영국)은 원가 칸을 비우고 사유를 적는다.
//
// 실행:
//   npm run excel -- output/rei-us.json
//   npm run excel -- output/*.json --output output/소싱목록.xlsx
//   npm run excel -- output/rei-us.json --business --markup 1.8 --sale-only

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { loadConfig, landedCost } = require("../api/_lib/landedCost");
const schema = require("../web/shared/schema.js");
const merge = require("../web/shared/merge.js");
const brands = require("../web/shared/brands.js");
const urls = require("../web/shared/urls.js");

const COUNTRY_KR = { US: "미국", JP: "일본", GB: "영국", DE: "독일", FR: "프랑스", IT: "이탈리아", ES: "스페인", NL: "네덜란드", EU: "유럽" };
const AVAILABILITY_KR = { in_stock: "재고 있음", out_of_stock: "품절", unknown: "재고 미확인", gone: "판매 종료" };
const STATUS_KR = {
  ok: "정상", empty: "상품 없음", partial: "일부만 수집", parse_error: "형식 오류",
  render_required: "구조화 데이터 없음", timeout: "시간 초과", rate_limited: "요청 제한(429)",
  blocked: "차단됨", robots_disallowed: "robots 제한", unsupported_endpoint: "주소 없음(404/410)",
  http_error: "연결/서버 오류", unverified: "미확인",
};

function parseArgs(argv) {
  const files = [];
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      files.push(a);
      continue;
    }
    const key = a.slice(2);
    if (["business", "sale-only", "help"].includes(key)) {
      flags[key] = true;
      continue;
    }
    flags[key] = argv[++i];
  }
  return { files, flags };
}

function usage() {
  console.log(`사용법:
  npm run excel -- <수집결과.json> [수집결과2.json ...] [옵션]

옵션:
  --output <파일>   저장 경로 (기본: output/소싱목록-<날짜>.xlsx)
  --business        사업자 사입 모드로 원가 계산 (기본: 구매대행)
  --markup <배수>   예상 판매가 배수 (기본 1.6)
  --sale-only       할인 중인 상품만
  --min-off <%>     최소 할인율 (예: 40)

예:
  npm run excel -- output/rei-us.json
  npm run excel -- output/rei-us.json output/jp.json --output output/소싱목록.xlsx
  npm run excel -- output/rei-us.json --business --markup 1.8 --sale-only`);
}

/** 여러 수집 파일을 읽어 하나의 상태로 합친다 */
function loadAndMerge(files) {
  let state = merge.emptyState();
  const warnings = [];
  const loaded = [];

  for (const file of files) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`파일을 찾을 수 없습니다: ${file}`);
    const stat = fs.statSync(abs);
    if (stat.size > schema.LIMITS.MAX_FILE_BYTES) {
      throw new Error(`파일이 너무 큽니다: ${file} (${Math.round(stat.size / 1048576)}MB)`);
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf-8"));
    } catch (e) {
      throw new Error(`JSON을 읽지 못했습니다: ${file} — ${e.message}`);
    }
    const validated = schema.validateResult(parsed);
    if (!validated.ok) throw new Error(`${file}: ${validated.errors.join(" / ")}`);
    validated.warnings.forEach((w) => warnings.push(`${path.basename(file)}: ${w}`));
    const res = merge.mergeResult(state, validated.result);
    state = res.state;
    loaded.push({ file: path.basename(file), items: validated.result.items.length });
  }
  return { state, warnings, loaded };
}

/** 상품 한 건 → 엑셀 한 행 */
function toRow(item, cfg, opts) {
  const cost = landedCost(
    cfg,
    {
      price: item.salePrice,
      currency: item.currency,
      marketCountry: item.marketCountry,
      region: item.region,
      category: item.category,
      weight_kg: item.weightKg,
    },
    opts.mode
  );
  const ok = cost.status === "ok";
  return {
    브랜드: brands.brandLabel(item.brandId, item.brand),
    브랜드영문: item.brand || "",
    상품명: item.name,
    판매처: item.sourceShop,
    국가: COUNTRY_KR[item.marketCountry] || item.marketCountry || "",
    통화: item.currency,
    정가: item.onSale ? item.listPrice : null,
    판매가: item.salePrice,
    할인율: item.onSale ? item.offRate / 100 : null,
    원가원: ok ? cost.totalKrw : null,
    예상판매가: ok ? Math.round(cost.totalKrw * opts.markup) : null,
    면세: ok ? (cost.taxFree ? "면세" : "과세") : "",
    원가비고: ok ? "" : cost.incompleteReason || "원가 계산 미완료",
    재고: AVAILABILITY_KR[item.availability] || item.availability || "",
    사이즈: item.sizes || "",
    색상: item.color || "",
    종류: item.category || "",
    무게kg: item.weightKg,
    SKU: item.sku || "",
    수집시각: item.collectedAt ? new Date(item.collectedAt) : null,
    상품링크: urls.safeHref(item.sourceUrl) || "",
    경고: (item.warnings || []).join(" / "),
  };
}

const COLUMNS = [
  { header: "브랜드", key: "브랜드", width: 16 },
  { header: "브랜드(영문)", key: "브랜드영문", width: 18 },
  { header: "상품명", key: "상품명", width: 44 },
  { header: "판매처", key: "판매처", width: 16 },
  { header: "국가", key: "국가", width: 8 },
  { header: "통화", key: "통화", width: 7 },
  { header: "정가", key: "정가", width: 11, numFmt: "#,##0.##" },
  { header: "판매가", key: "판매가", width: 11, numFmt: "#,##0.##" },
  { header: "할인율", key: "할인율", width: 9, numFmt: "0%" },
  { header: "최종원가(원)", key: "원가원", width: 14, numFmt: "#,##0" },
  { header: "예상판매가(원)", key: "예상판매가", width: 15, numFmt: "#,##0" },
  { header: "관세", key: "면세", width: 8 },
  { header: "원가 비고", key: "원가비고", width: 32 },
  { header: "재고", key: "재고", width: 11 },
  { header: "사이즈", key: "사이즈", width: 22 },
  { header: "색상", key: "색상", width: 14 },
  { header: "종류", key: "종류", width: 10 },
  { header: "무게(kg)", key: "무게kg", width: 9, numFmt: "0.0" },
  { header: "SKU", key: "SKU", width: 16 },
  { header: "수집시각", key: "수집시각", width: 18, numFmt: "yyyy-mm-dd hh:mm" },
  { header: "상품링크", key: "상품링크", width: 46 },
  { header: "수집 경고", key: "경고", width: 28 },
];

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF191512" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = HEADER_FONT;
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle" };
  row.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

function buildWorkbook(state, opts, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "핫딜 레이더";
  wb.created = new Date();

  // ---------- 1) 상품 ----------
  const sheet = wb.addWorksheet("상품", { properties: { defaultRowHeight: 18 } });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const rows = state.items
    .map((it) => toRow(it, opts.cfg, opts))
    .filter((r) => (opts.saleOnly ? r.할인율 !== null : true))
    .filter((r) => (opts.minOff ? (r.할인율 || 0) * 100 >= opts.minOff : true))
    // 할인율 높은 순 → 원가 낮은 순
    .sort((a, b) => (b.할인율 || 0) - (a.할인율 || 0) || (a.원가원 || Infinity) - (b.원가원 || Infinity));

  rows.forEach((r) => {
    const row = sheet.addRow(r);
    // 링크는 클릭 가능하게
    const linkCell = row.getCell("상품링크");
    if (r.상품링크) {
      linkCell.value = { text: r.상품링크, hyperlink: r.상품링크 };
      linkCell.font = { color: { argb: "FF0B6E4F" }, underline: true };
    }
    // 40% 이상 할인은 눈에 띄게
    if ((r.할인율 || 0) >= 0.4) {
      row.getCell("할인율").font = { bold: true, color: { argb: "FFD6202B" } };
    }
    // 원가를 계산하지 못한 행은 옅게 표시해 실수로 그대로 쓰지 않게 한다
    if (r.원가원 === null) {
      row.getCell("원가비고").font = { color: { argb: "FF7A736C" }, italic: true };
    }
    if (r.재고 === "품절") row.font = { color: { argb: "FF9A938B" } };
  });

  COLUMNS.forEach((c) => {
    if (c.numFmt) sheet.getColumn(c.key).numFmt = c.numFmt;
  });
  styleHeader(sheet);

  // ---------- 2) 판매처 상태 ----------
  const status = wb.addWorksheet("판매처 상태");
  status.columns = [
    { header: "판매처 ID", key: "sourceId", width: 22 },
    { header: "판매처", key: "shop", width: 20 },
    { header: "국가", key: "country", width: 8 },
    { header: "수집 범위", key: "scope", width: 18 },
    { header: "상태", key: "status", width: 20 },
    { header: "범위 완료", key: "complete", width: 10 },
    { header: "발견", key: "discovered", width: 8, numFmt: "#,##0" },
    { header: "조회", key: "fetched", width: 8, numFmt: "#,##0" },
    { header: "정상", key: "accepted", width: 8, numFmt: "#,##0" },
    { header: "제외", key: "rejected", width: 8, numFmt: "#,##0" },
    { header: "HTTP", key: "http", width: 8 },
    { header: "오류", key: "error", width: 52 },
    { header: "이어받기", key: "cursor", width: 12 },
    { header: "목록 URL", key: "listing", width: 46 },
  ];
  (state.sourceResults || []).forEach((sr) => {
    status.addRow({
      sourceId: sr.sourceId,
      shop: sr.sourceShop || sr.brand || "",
      country: COUNTRY_KR[sr.marketCountry] || sr.marketCountry || "",
      scope: sr.scope ? `${sr.scope.kind}${sr.scope.value ? ":" + sr.scope.value : ""}` : "",
      status: STATUS_KR[sr.status] || sr.status,
      complete: sr.complete ? "완료" : "미완료",
      discovered: sr.discovered || 0,
      fetched: sr.fetched || 0,
      accepted: sr.accepted || 0,
      rejected: sr.rejected || 0,
      http: sr.httpStatus || "",
      error: sr.error || "",
      cursor: sr.nextCursor ? "가능" : "",
      listing: sr.listingUrl || "",
    });
  });
  styleHeader(status);

  // ---------- 3) 브랜드 요약 ----------
  const summary = wb.addWorksheet("브랜드 요약");
  summary.columns = [
    { header: "브랜드", key: "brand", width: 20 },
    { header: "상품 수", key: "count", width: 10, numFmt: "#,##0" },
    { header: "세일 상품", key: "sale", width: 10, numFmt: "#,##0" },
    { header: "최고 할인율", key: "maxOff", width: 12, numFmt: "0%" },
    { header: "평균 할인율", key: "avgOff", width: 12, numFmt: "0%" },
    { header: "최저 원가(원)", key: "minCost", width: 14, numFmt: "#,##0" },
    { header: "판매처", key: "shops", width: 30 },
  ];
  const byBrand = new Map();
  rows.forEach((r) => {
    if (!byBrand.has(r.브랜드)) byBrand.set(r.브랜드, { count: 0, sale: 0, offs: [], minCost: null, shops: new Set() });
    const b = byBrand.get(r.브랜드);
    b.count++;
    b.shops.add(r.판매처);
    if (r.할인율 !== null) {
      b.sale++;
      b.offs.push(r.할인율);
    }
    if (r.원가원 !== null) b.minCost = b.minCost === null ? r.원가원 : Math.min(b.minCost, r.원가원);
  });
  [...byBrand.entries()]
    .sort((a, b) => b[1].sale - a[1].sale || b[1].count - a[1].count)
    .forEach(([brand, b]) => {
      summary.addRow({
        brand,
        count: b.count,
        sale: b.sale,
        maxOff: b.offs.length ? Math.max(...b.offs) : null,
        avgOff: b.offs.length ? b.offs.reduce((s, v) => s + v, 0) / b.offs.length : null,
        minCost: b.minCost,
        shops: [...b.shops].join(", "),
      });
    });
  styleHeader(summary);

  // ---------- 4) 실행 정보 ----------
  const info = wb.addWorksheet("실행 정보");
  info.columns = [
    { header: "항목", key: "k", width: 24 },
    { header: "값", key: "v", width: 80 },
  ];
  [
    ["만든 시각", new Date().toLocaleString("ko-KR")],
    ["통관 모드", opts.mode === "business" ? "사업자 사입" : "구매대행"],
    ["판매가 배수", String(opts.markup)],
    ["환율 기준일", (opts.cfg.fx && opts.cfg.fx.as_of) || "미상"],
    ["환율(USD/EUR/JPY)", `${opts.cfg.fx.base_rate.USD} / ${opts.cfg.fx.base_rate.EUR} / ${opts.cfg.fx.base_rate.JPY}`],
    ["카드 수수료", `${(opts.cfg.fx.card_fee_rate * 100).toFixed(1)}%`],
    ["요율 기준일", (opts.cfg.meta && opts.cfg.meta.last_verified) || "미상"],
    ["원본 파일", meta.loaded.map((l) => `${l.file} (${l.items}건)`).join(", ")],
    ["상품 수", `${rows.length}건 (필터 전 ${state.items.length}건)`],
    ["주의", "가격·재고는 수집 시점 값입니다. 24시간이 지났으면 다시 수집하세요."],
    ["주의", "'최종원가(원)'이 비어 있으면 그 시장의 세금·배대지 조건이 검증되지 않은 것입니다(원가 비고 참고)."],
  ]
    .concat(meta.warnings.map((w) => ["경고", w]))
    .forEach(([k, v]) => info.addRow({ k, v }));
  styleHeader(info);

  return { wb, rowCount: rows.length };
}

async function main() {
  const { files, flags } = parseArgs(process.argv);
  if (flags.help || !files.length) {
    usage();
    process.exit(files.length ? 0 : 1);
  }

  const cfg = loadConfig();
  const opts = {
    cfg,
    mode: flags.business ? "business" : "proxy",
    markup: parseFloat(flags.markup) > 0 ? parseFloat(flags.markup) : 1.6,
    saleOnly: !!flags["sale-only"],
    minOff: parseInt(flags["min-off"], 10) || 0,
  };

  const { state, warnings, loaded } = loadAndMerge(files);
  const { wb, rowCount } = buildWorkbook(state, opts, { warnings, loaded });

  if (!rowCount) {
    console.error("조건에 맞는 상품이 없어 엑셀을 만들지 않았습니다. --sale-only / --min-off 조건을 확인하세요.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = flags.output ? path.resolve(flags.output) : path.join(process.cwd(), "output", `소싱목록-${stamp}.xlsx`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // 임시 파일에 쓰고 교체한다 — 실패한 실행이 기존 엑셀을 덮어쓰지 않는다
  const tmp = outFile + ".tmp";
  await wb.xlsx.writeFile(tmp);
  fs.renameSync(tmp, outFile);

  console.log(`엑셀 생성 완료: ${rowCount}건 → ${outFile}`);
  console.log("시트: 상품 / 판매처 상태 / 브랜드 요약 / 실행 정보");
  warnings.forEach((w) => console.log("경고:", w));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("실패:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { loadAndMerge, buildWorkbook, toRow, COLUMNS, parseArgs };
