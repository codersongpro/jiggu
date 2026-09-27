#!/usr/bin/env node
// PC 브라우저 수집기 — Shopify products.json이 없는 사이트(REI, 편집숍, 일본·유럽 몰 등)용.
//
// 왜 PC인가: Vercel 서버리스에서는 브라우저를 띄울 수 없고, 서버 IP로 나가는 요청은
// 이미 여러 사이트에서 막히는 게 확인됐다. 그래서 사용자 PC에서 직접 돌린다.
//
// 이 스크립트가 하지 않는 것: 봇 탐지 우회. TLS 지문 위장·Stealth 플러그인·주거용
// 프록시·캡차 자동 풀이는 쓰지 않는다. 차단(403/캡차)이 확인되면 그 소스는 중단하고
// blocked로 기록한다.
//
// 실행 예:
//   npm ci && npx playwright install chromium
//   npm run crawl -- --source rei-us --limit 20 --output output/rei-us.json
//   npm run crawl -- --countries US,JP,GB,DE,FR,IT,ES,NL --limit 100 --output output/scan.json
//   npm run crawl -- --source rei-us --brand patagonia --limit 100 --output output/rei-patagonia.json
//   npm run crawl -- --resume output/scan.json --output output/scan-resumed.json
//   npm run crawl -- --source rei-us --business --limit 20 --output output/rei-business.json
//
// 종료 코드: 0 요청 범위 정상 완료 / 2 일부 성공·한도 중단 / 1 유효 결과 없음·입력 오류

const fs = require("fs");
const path = require("path");
const targets = require("../../config/targets.json");
const { loadConfig, landedCost } = require("../../api/_lib/landedCost");
const sourcesLib = require("../../web/shared/sources.js");
const schema = require("../../web/shared/schema.js");
const brands = require("../../web/shared/brands.js");
const { getAdapter } = require("../../crawlers");

const S = schema.SOURCE_STATUS;

// CLAUDE.md 수집 규칙: 도메인당 동시 1, 요청 간 2~5초 랜덤 대기
const DELAY_MS = [2000, 5000];
const DEFAULT_CONCURRENCY = 2; // 동시에 보는 판매처 수
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_RETRY = 2; // 일시적 네트워크 오류·5xx만

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => DELAY_MS[0] + Math.random() * (DELAY_MS[1] - DELAY_MS[0]);

// 재시도해도 되는 상태 (429·차단·404는 재시도하지 않는다)
const RETRYABLE = [S.TIMEOUT, S.HTTP_ERROR];
// 그 판매처를 즉시 중단해야 하는 상태
const FATAL = [S.BLOCKED, S.ROBOTS_DISALLOWED, S.RATE_LIMITED];

function usage() {
  console.log(`사용법:
  npm run crawl -- --source <sourceId> [--brand <브랜드>] [--limit N] [--business] [--output <파일>]
  npm run crawl -- --countries US,JP,GB,DE,FR,IT,ES,NL [--limit N] [--business] [--output <파일>]
  npm run crawl -- --resume <이전결과.json> [--limit N] [--output <파일>]

옵션:
  --source      판매처 ID (config/targets.json의 sourceId). --countries와 함께 쓸 수 없다
  --countries   시장(국가) 코드 목록. 해당 국가의 PC 수집 대상 판매처를 모두 본다
  --brand       브랜드 ID/영문/한글/별칭. 발견 결과에서 그 브랜드만 남긴다
  --limit       판매처당 수집할 고유 상품 수 (1~${MAX_LIMIT}, 기본 ${DEFAULT_LIMIT})
  --resume      이전 결과 파일을 이어받는다. 다른 대상 선택 옵션과 함께 쓸 수 없다
  --business    사업자 사입 모드로 원가 계산 (기본: 구매대행)
  --concurrency 동시에 보는 판매처 수 (기본 ${DEFAULT_CONCURRENCY})
  --output      결과 JSON 경로 (기본 output/local-scan-<타임스탬프>.json)
  --xlsx        수집이 끝나면 같은 이름의 엑셀(.xlsx)도 함께 만든다
  --headed      브라우저 창을 띄워서 실행 (동작 확인용)

등록된 판매처는 config/targets.json에서 확인한다.`);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (["business", "headed", "help", "xlsx"].includes(key)) {
      flags[key] = true;
      continue;
    }
    flags[key] = argv[++i];
  }
  return flags;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 한 판매처를 수집한다 */
async function crawlSource(context, source, opts, prior) {
  const adapter = getAdapter(source.adapter);
  const scope = opts.brandId ? { kind: "brand", value: opts.brandId } : { kind: "listing", value: null };
  const collected = new Map(); // productId → item
  let cursor = (prior && prior.cursor) || null;
  let status = S.OK;
  let httpStatus = null;
  let error = null;
  let pages = 0;
  let discovered = 0;
  let fetched = 0;
  let rejected = 0;
  let retryAfter = null;
  let hitLimit = false;
  const seenIds = new Set((prior && prior.seenIds) || []);

  if (!adapter) {
    return {
      items: [],
      result: schema.makeSourceResult(source, { scope, status: S.UNVERIFIED, error: `모르는 어댑터: ${source.adapter}` }),
    };
  }

  // 요청 간격 — 기본은 CLAUDE.md 규칙(2~5초 랜덤). 테스트에서만 0으로 줄인다.
  const wait = (factor) => sleep((opts.delayMs !== undefined ? opts.delayMs : randomDelay()) * (factor || 1));

  const page = await context.newPage();
  try {
    while (collected.size < opts.limit) {
      // ---- 목록에서 상품 URL 발견 ----
      let discovery = null;
      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        discovery = await adapter.discoverProducts({ page, source, cursor, limit: opts.limit * 2 });
        if (RETRYABLE.indexOf(discovery.status) < 0) break;
        await wait(attempt + 1);
      }
      pages += discovery.pages || 1;
      discovered += discovery.links.length;
      httpStatus = discovery.httpStatus || httpStatus;

      if (FATAL.indexOf(discovery.status) >= 0) {
        status = discovery.status;
        error = discovery.error || `목록 조회 실패 (${discovery.status})`;
        retryAfter = discovery.retryAfter || null;
        break;
      }
      if (discovery.status !== S.OK && discovery.status !== S.EMPTY) {
        status = discovery.status;
        error = discovery.error || null;
        break;
      }

      // ---- 상품 상세 ----
      for (const link of discovery.links) {
        if (collected.size >= opts.limit) {
          hitLimit = true;
          break;
        }
        if (seenIds.has(link.productId)) continue;
        seenIds.add(link.productId);

        await wait();
        let detail = null;
        for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
          detail = await adapter.fetchOffers({ page, source, url: link.url });
          if (RETRYABLE.indexOf(detail.status) < 0) break;
          await wait(attempt + 1);
        }
        fetched++;

        if (FATAL.indexOf(detail.status) >= 0) {
          // 차단·429는 이 판매처를 중단한다 (개별 404와 다르다)
          status = detail.status;
          error = detail.error || `상세 조회 차단 (${detail.status})`;
          break;
        }
        if (!detail.item) {
          // 개별 404·파싱 실패는 다음 상품으로 진행한다
          rejected++;
          if (opts.verbose) console.log(`  · 건너뜀 ${link.url} (${detail.status})`);
          continue;
        }
        if (opts.brandId && !brands.sameBrand(detail.item.brandId || detail.item.brand, opts.brandId)) {
          rejected++;
          continue;
        }
        collected.set(link.productId, Object.assign({}, detail.item, { collectedAt: new Date().toISOString() }));
        if (opts.verbose) console.log(`  · ${detail.item.brand} / ${detail.item.name} ${detail.item.currency} ${detail.item.salePrice}`);
      }

      if (FATAL.indexOf(status) >= 0) break;
      cursor = discovery.nextCursor;
      if (!cursor) break;
      if (collected.size >= opts.limit) {
        hitLimit = true;
        break;
      }
    }
  } catch (err) {
    status = S.HTTP_ERROR;
    error = String(err && err.message).slice(0, 300);
  } finally {
    await page.close().catch(() => {});
  }

  const items = [...collected.values()];
  const finishedRange = !cursor && FATAL.indexOf(status) < 0 && (status === S.OK || status === S.EMPTY);
  const complete = finishedRange && !hitLimit;
  const finalStatus =
    FATAL.indexOf(status) >= 0 || (status !== S.OK && status !== S.EMPTY)
      ? status
      : !items.length
      ? S.EMPTY
      : complete
      ? S.OK
      : S.PARTIAL;

  const result = schema.makeSourceResult(source, {
    scope,
    status: finalStatus,
    complete,
    nextCursor: cursor ? JSON.stringify(cursor) : null,
    httpStatus,
    retryAfter,
    error,
    discovered,
    fetched,
    accepted: items.length,
    rejected,
    pages,
    listingUrl: (source.listingUrls || [])[0] || null,
  });
  result.seenIds = [...seenIds].slice(0, 5000); // resume용
  return { items, result };
}

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.help) {
    usage();
    process.exit(0);
  }

  const { sources, errors: cfgErrors } = sourcesLib.loadSources(targets);
  if (cfgErrors.length) fail("config/targets.json 오류:\n  " + cfgErrors.join("\n  "));

  const selectors = ["source", "countries", "resume"].filter((k) => flags[k]);
  if (selectors.length === 0) {
    usage();
    console.error("\n--source, --countries, --resume 중 하나는 지정해야 합니다.");
    process.exit(1);
  }
  if (selectors.length > 1) fail(`대상 선택 옵션은 하나만 씁니다 (지정됨: ${selectors.map((s) => "--" + s).join(", ")})`);

  const limitRaw = flags.limit === undefined ? null : parseInt(flags.limit, 10);
  if (limitRaw !== null && !(Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= MAX_LIMIT)) {
    fail(`--limit는 1~${MAX_LIMIT} 사이 정수여야 합니다`);
  }

  // ---- 대상 결정 ----
  let plan = [];
  let prior = null;
  let mode = flags.business ? "business" : "proxy";
  let brandId = flags.brand ? brands.canonicalBrandId(flags.brand) || String(flags.brand).toLowerCase() : null;

  if (flags.resume) {
    const resumePath = path.resolve(flags.resume);
    if (!fs.existsSync(resumePath)) fail(`이어받을 파일이 없습니다: ${resumePath}`);
    const parsed = JSON.parse(fs.readFileSync(resumePath, "utf-8"));
    const check = schema.validateResult(parsed);
    if (!check.ok) fail("이어받을 파일을 읽지 못했습니다: " + check.errors.join(" / "));
    prior = { file: parsed, result: check.result };
    mode = parsed.mode || mode;
    brandId = (parsed.options && parsed.options.brandId) || brandId;
    const ids = [...new Set(check.result.sourceResults.map((r) => r.sourceId))];
    plan = ids.map((id) => sourcesLib.findSource(sources, id)).filter(Boolean);
    if (!plan.length) fail("이어받을 판매처를 config/targets.json에서 찾지 못했습니다");
  } else if (flags.source) {
    const s = sourcesLib.findSource(sources, String(flags.source));
    if (!s) fail(`등록되지 않은 sourceId입니다: ${flags.source}`);
    if (sourcesLib.isBlocked(s)) fail(`${s.sourceId}는 차단 상태로 기록돼 있습니다 (support.status=${s.support.status})`);
    plan = [s];
  } else {
    const countries = String(flags.countries)
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (!countries.length) fail("--countries에 국가 코드를 넣어주세요 (예: US,JP,GB)");
    plan = sourcesLib.selectSources(sources, { runtime: "pc", marketCountries: countries, brandId });
    if (!plan.length) fail(`해당 국가의 PC 수집 대상 판매처가 없습니다: ${countries.join(",")}`);
  }

  const priorLimit = prior && prior.file.options && prior.file.options.limit;
  const limit = limitRaw !== null ? limitRaw : priorLimit || DEFAULT_LIMIT;
  const concurrency = Math.max(1, Math.min(4, parseInt(flags.concurrency, 10) || DEFAULT_CONCURRENCY));

  console.log(`대상 판매처 ${plan.length}곳 · 판매처당 최대 ${limit}건 · ${mode === "business" ? "사업자 사입" : "구매대행"} 모드`);
  plan.forEach((s) => console.log(`  - ${s.sourceId} (${s.shopName}, ${s.marketCountry || "시장 미확인"}, ${s.adapter})`));
  if (brandId) console.log(`브랜드 필터: ${brands.brandLabel(brandId, brandId)}`);

  const { chromium } = require("playwright");
  // 브라우저 경로를 직접 지정해야 하는 환경(사내 이미지 등)은 환경변수로 넘긴다
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: !flags.headed, executablePath });
  const context = await browser.newContext({ locale: "en-US" });

  const results = [];
  const collectedItems = [];
  const queue = plan.slice();

  // 판매처는 동시 N곳, 한 판매처 안에서는 순차(도메인당 동시 1)
  async function worker() {
    while (queue.length) {
      const source = queue.shift();
      const priorResult = prior
        ? prior.result.sourceResults.find((r) => r.sourceId === source.sourceId)
        : null;
      const priorCursor = priorResult && priorResult.nextCursor ? JSON.parse(priorResult.nextCursor) : null;
      const priorSeen = (prior && prior.file.sourceResults || []).find((r) => r.sourceId === source.sourceId);
      console.log(`\n[${source.sourceId}] 수집 시작 ${priorCursor ? "(이어받기)" : ""}`);
      const { items, result } = await crawlSource(
        context,
        Object.assign({}, source, { locale: source.locale }),
        { limit, brandId, verbose: true },
        { cursor: priorCursor, seenIds: (priorSeen && priorSeen.seenIds) || [] }
      );
      console.log(`[${source.sourceId}] ${result.status} · 발견 ${result.discovered} / 조회 ${result.fetched} / 정상 ${result.accepted}${result.error ? " · " + result.error : ""}`);
      results.push(result);
      collectedItems.push(...items);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  await browser.close();

  // ---- 원가 계산 + 이전 결과 누적 ----
  const cfg = loadConfig();
  const withCost = collectedItems.map((item) => {
    const scopeSource = results.find((r) => r.sourceId === item.sourceId);
    return Object.assign({}, item, {
      scopeId: scopeSource ? schema.scopeKey(scopeSource) : null,
      cost: landedCost(
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
      ),
    });
  });

  const merged = new Map();
  if (prior) prior.result.items.forEach((it) => merged.set(it.key || schema.itemKey(it), it));
  withCost.forEach((it) => merged.set(schema.itemKey(it), it));

  // 이전 실행에서 이미 완료된 범위의 상태를 이어받는다
  const mergedResults = new Map();
  if (prior) prior.result.sourceResults.forEach((r) => mergedResults.set(schema.scopeKey(r), r));
  results.forEach((r) => {
    const key = schema.scopeKey(r);
    const before = mergedResults.get(key);
    if (before) {
      r.discovered += before.discovered || 0;
      r.fetched += before.fetched || 0;
      r.accepted += before.accepted || 0;
      r.rejected += before.rejected || 0;
      r.pages += before.pages || 0;
      // 원래 범위의 처음부터 끝까지 누적된 경우에만 complete=true
      r.complete = r.complete && (before.complete || before.nextCursor !== null || before.status === S.PARTIAL);
    }
    mergedResults.set(key, r);
  });

  const items = [...merged.values()];
  if (!items.length) {
    console.error("\n수집된 상품이 없습니다. 위의 판매처별 상태를 확인하세요.");
    printSummary([...mergedResults.values()]);
    process.exit(1);
  }

  const output = {
    schemaVersion: schema.SCHEMA_VERSION,
    runId: `crawl-${Date.now()}`,
    collectedAt: new Date().toISOString(),
    scannedAt: new Date().toISOString(), // 구형 호환
    mode,
    options: { limit, brandId, countries: flags.countries || null, source: flags.source || null },
    sourceResults: [...mergedResults.values()],
    itemCount: items.length,
    items,
  };

  const outFile = flags.output
    ? path.resolve(flags.output)
    : path.join(process.cwd(), "output", `local-scan-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2));
  const check = schema.validateResult(JSON.parse(fs.readFileSync(tmp, "utf-8")));
  if (!check.ok) {
    fs.unlinkSync(tmp);
    console.error("출력 검증 실패 — 기존 파일을 그대로 둡니다: " + check.errors.join(" / "));
    process.exit(1);
  }
  fs.renameSync(tmp, outFile);

  console.log(`\n완료: ${items.length}건 → ${outFile}`);

  // --xlsx: 같은 결과를 엑셀로도 정리한다 (실패해도 JSON 결과는 그대로 남는다)
  if (flags.xlsx) {
    try {
      const { loadAndMerge, buildWorkbook } = require("../export-excel.js");
      const merged = loadAndMerge([outFile]);
      const { wb, rowCount } = buildWorkbook(merged.state, { cfg, mode, markup: 1.6, saleOnly: false, minOff: 0 }, merged);
      const xlsxFile = outFile.replace(/\.json$/i, "") + ".xlsx";
      await wb.xlsx.writeFile(xlsxFile);
      console.log(`엑셀 생성 완료: ${rowCount}건 → ${xlsxFile}`);
    } catch (err) {
      console.warn("엑셀 생성 실패(수집 결과 JSON은 정상 저장됨):", err && err.message);
    }
  }

  printSummary(output.sourceResults);
  console.log("앱 설정 탭 > '수집 결과 가져오기'에서 이 파일을 열면 상품 탭에 합쳐집니다.");

  const allOk = output.sourceResults.every((r) => (r.status === S.OK || r.status === S.EMPTY) && r.complete);
  process.exit(allOk ? 0 : 2);
}

function printSummary(results) {
  console.log("\n판매처별 상태:");
  results.forEach((r) => {
    console.log(
      `  ${r.sourceId.padEnd(22)} ${String(r.status).padEnd(20)} 정상 ${String(r.accepted).padStart(4)}건` +
        `${r.complete ? " · 범위 완료" : r.nextCursor ? " · 이어받기 가능" : ""}${r.error ? " · " + r.error : ""}`
    );
  });
  if (results.some((r) => r.nextCursor)) {
    console.log("\n이어받으려면: npm run crawl -- --resume <이 결과 파일> --output <새 파일>");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("실행 실패:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { crawlSource, parseArgs, DELAY_MS, MAX_RETRY, RETRYABLE, FATAL };
