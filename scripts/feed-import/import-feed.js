#!/usr/bin/env node
// 어필리에이트 상품 피드 → 앱 상품 목록 변환기 (CLI)
//
// 코치·마이클코어스·케이트스페이드·랄프로렌처럼 서버 요청을 차단하는 브랜드의 가격 데이터를
// 얻는 정공법이다. 스크래핑이 아니라 브랜드가 제휴사에 공식 제공하는 상품 피드를 읽는다.
// 파싱·변환 로직은 lib.js에 있고 여기서는 옵션 처리와 파일 출력만 한다.
//
// 실행:
//   node scripts/feed-import/import-feed.js <피드파일> [옵션]
//
//   --brand "Coach"      피드에 브랜드 컬럼이 없을 때 브랜드명을 강제 지정
//   --shop "코치 (제휴피드)"  구입처 표시 이름 (기본: 파일명)
//   --source-id coach-feed   판매처 ID (기본: 파일명 기반 슬러그)
//   --market US|DE|JP|GB 시장(국가) 지정. 통화만으로는 EUR 국가를 알 수 없다
//   --sale-only          정가 대비 할인된 상품만 남긴다
//   --business           사업자 사입 모드로 원가 계산 (기본: 구매대행)
//   --limit 500          최대 상품 수 (기본 1000)
//   --output <파일>      결과 JSON 경로 (기본: scripts/feed-import/output/feed-<타임스탬프>.json)
//   --map name=제목,salePrice=판매가   컬럼 직접 지정 (자동 인식 실패 시)
//
// 종료 코드: 0 정상, 2 일부 성공/한도 중단, 1 유효 결과 없음 또는 입력 오류

const fs = require("fs");
const path = require("path");
const { loadConfig, landedCost } = require("../../api/_lib/landedCost");
const schema = require("../../web/shared/schema.js");
const lib = require("./lib.js");

function parseArgs(argv) {
  const args = { file: null, flags: {}, map: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!args.file) args.file = a;
      continue;
    }
    const key = a.slice(2);
    if (["sale-only", "business", "help"].includes(key)) {
      args.flags[key] = true;
      continue;
    }
    const value = argv[++i];
    if (key === "map") {
      String(value || "").split(",").forEach((pair) => {
        const [field, column] = pair.split("=");
        if (field && column) args.map[field.trim()] = column.trim();
      });
    } else {
      args.flags[key] = value;
    }
  }
  return args;
}

function usage() {
  console.error('사용법: node scripts/feed-import/import-feed.js <피드파일> [--brand "Coach"] [--market US] [--sale-only]');
  console.error("자세한 옵션은 scripts/feed-import/README.md 참고");
}

const args = parseArgs(process.argv);
if (!args.file || args.flags.help) {
  usage();
  process.exit(1);
}
if (!fs.existsSync(args.file)) {
  console.error(`파일을 찾을 수 없습니다: ${args.file}`);
  process.exit(1);
}

const { rows, format } = lib.loadFeed(args.file);
if (!rows.length) {
  console.error("피드에서 상품 행을 하나도 읽지 못했습니다. 파일 형식을 확인하세요.");
  process.exit(1);
}

const mapping = lib.buildMapping(rows[0], args.map);
console.log(`형식: ${format} · 행 ${rows.length}개`);
console.log("컬럼 매핑:");
Object.keys(lib.FIELD_ALIASES).forEach((field) => {
  console.log(`  ${field.padEnd(12)} → ${mapping[field] || "(못 찾음)"}`);
});

// 가격은 salePrice / price / listPrice 중 하나만 있어도 된다(리뷰 R06 — g:price 단독 피드)
const hasPrice = !!(mapping.salePrice || mapping.price || mapping.listPrice);
if (!mapping.name || !hasPrice) {
  console.error(`\n필수 컬럼을 못 찾았습니다: ${[!mapping.name && "name", !hasPrice && "price"].filter(Boolean).join(", ")}`);
  console.error(`피드의 실제 컬럼: ${Object.keys(rows[0]).join(", ")}`);
  console.error('--map 옵션으로 직접 지정하세요. 예: --map "name=제목,salePrice=판매가"');
  process.exit(1);
}

const base = path.basename(args.file).replace(/\.[^.]+$/, "");
const mode = args.flags.business ? "business" : "proxy";
const opts = {
  brand: args.flags.brand || "",
  shop: args.flags.shop || base,
  sourceId: String(args.flags["source-id"] || `feed-${base}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""),
  marketCountry: args.flags.market ? String(args.flags.market).toUpperCase() : "",
  region: "",
  saleOnly: !!args.flags["sale-only"],
  currencyFallback: null, // 통화를 모르면 건너뛴다. USD로 넘겨짚지 않는다
};
const limit = parseInt(args.flags.limit, 10) || lib.DEFAULT_LIMIT;

const cfg = loadConfig();
const items = [];
const skipReasons = {};
let incompleteCost = 0;

for (let i = 0; i < rows.length && items.length < limit; i++) {
  const res = lib.toItem(rows[i], mapping, opts, i);
  if (res.skip) {
    skipReasons[res.skip] = (skipReasons[res.skip] || 0) + 1;
    continue;
  }
  const item = res.item;
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
    mode
  );
  if (cost.status === "incomplete") incompleteCost++;
  items.push(Object.assign({}, item, { cost, collectedAt: new Date().toISOString() }));
}

if (!items.length) {
  console.error("\n변환된 상품이 없습니다. 건너뛴 이유:", JSON.stringify(skipReasons, null, 1));
  process.exit(1);
}

const truncated = items.length >= limit && rows.length > limit;
const sourceResult = schema.makeSourceResult(
  { sourceId: opts.sourceId, shopName: opts.shop, marketCountry: opts.marketCountry || null },
  {
    scope: { kind: "feed", value: path.basename(args.file) },
    status: truncated ? schema.SOURCE_STATUS.PARTIAL : schema.SOURCE_STATUS.OK,
    complete: !truncated,
    discovered: rows.length,
    fetched: rows.length,
    accepted: items.length,
    rejected: rows.length - items.length,
  }
);
const scopeId = schema.scopeKey(sourceResult);
items.forEach((it) => {
  it.scopeId = scopeId;
});

const output = {
  schemaVersion: schema.SCHEMA_VERSION,
  runId: `feed-${Date.now()}`,
  collectedAt: new Date().toISOString(),
  scannedAt: new Date().toISOString(), // 구형 호환
  mode,
  source: "affiliate-feed",
  sourceResults: [sourceResult],
  itemCount: items.length,
  items,
};

const outFile = args.flags.output
  ? path.resolve(args.flags.output)
  : path.join(__dirname, "output", `feed-${Date.now()}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
// 임시 파일에 쓰고 검증한 뒤 교체한다 — 실패한 실행으로 기존 결과를 덮어쓰지 않는다
const tmpFile = outFile + ".tmp";
fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2));
const check = schema.validateResult(JSON.parse(fs.readFileSync(tmpFile, "utf-8")));
if (!check.ok) {
  fs.unlinkSync(tmpFile);
  console.error("\n출력 검증 실패 — 기존 파일을 그대로 두고 종료합니다:", check.errors.join(" / "));
  process.exit(1);
}
fs.renameSync(tmpFile, outFile);

console.log(`\n변환 완료: ${items.length}건 → ${outFile}`);
if (Object.keys(skipReasons).length) console.log("건너뜀:", JSON.stringify(skipReasons));
if (incompleteCost) {
  console.log(`원가 계산 미완료 ${incompleteCost}건 — 세금·배대지 조건이 검증되지 않은 시장(예: GB)입니다. 원문 가격은 그대로 보존됩니다.`);
}
if (check.warnings.length) console.log("경고:", check.warnings.join(" / "));
console.log("앱 설정 탭 > '수집 결과 가져오기'에서 이 파일을 열면 상품 탭에 합쳐집니다.");
process.exit(truncated ? 2 : 0);
