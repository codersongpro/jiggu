// 엑셀 출력 회귀 테스트 — 실제 .xlsx를 만들고 다시 읽어 값을 확인한다
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");

const { loadConfig, landedCost } = require("../api/_lib/landedCost");
const { loadAndMerge, buildWorkbook } = require("../scripts/export-excel.js");

const cfg = loadConfig();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jiggu-xlsx-"));

function item(over) {
  return Object.assign(
    {
      sourceId: "rei-us",
      productId: "184879",
      variantId: "v1",
      sku: "184879",
      brand: "Patagonia",
      name: "Nano Puff Hoody",
      currency: "USD",
      salePrice: 149,
      listPrice: 199,
      marketCountry: "US",
      region: "US",
      category: "apparel",
      weightKg: 0.8,
      sizes: "M / L",
      color: "Black",
      availability: "in_stock",
      sourceShop: "REI",
      sourceUrl: "https://www.rei.com/product/184879/nano-puff",
      collectedAt: new Date().toISOString(),
    },
    over || {}
  );
}

function writeResult(name, items, sourceResults) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      runId: "test",
      collectedAt: new Date().toISOString(),
      sourceResults: sourceResults || [
        { sourceId: "rei-us", sourceShop: "REI", marketCountry: "US", status: "ok", complete: true, scope: { kind: "listing", value: null }, discovered: 20, fetched: 20, accepted: items.length },
      ],
      items,
    })
  );
  return file;
}

async function build(files, opts) {
  const merged = loadAndMerge(files);
  const { wb, rowCount } = buildWorkbook(
    merged.state,
    Object.assign({ cfg, mode: "proxy", markup: 1.6, saleOnly: false, minOff: 0 }, opts || {}),
    merged
  );
  const out = path.join(tmpDir, `out-${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(out);
  const read = new ExcelJS.Workbook();
  await read.xlsx.readFile(out);
  return { wb: read, rowCount, file: out };
}

const headerIndex = (sheet, header) => {
  const row = sheet.getRow(1);
  for (let i = 1; i <= row.cellCount; i++) if (row.getCell(i).value === header) return i;
  return -1;
};
const cellOf = (sheet, rowNo, header) => sheet.getRow(rowNo).getCell(headerIndex(sheet, header)).value;

test("엑셀 4개 시트를 만들고 상품 값을 그대로 담는다", async () => {
  const file = writeResult("one.json", [item()]);
  const { wb, rowCount } = await build([file]);
  assert.strictEqual(rowCount, 1);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["상품", "판매처 상태", "브랜드 요약", "실행 정보"]);

  const sheet = wb.getWorksheet("상품");
  assert.strictEqual(cellOf(sheet, 2, "브랜드"), "파타고니아", "한글 브랜드명으로 정리한다");
  assert.strictEqual(cellOf(sheet, 2, "브랜드(영문)"), "Patagonia");
  assert.strictEqual(cellOf(sheet, 2, "상품명"), "Nano Puff Hoody");
  assert.strictEqual(cellOf(sheet, 2, "판매처"), "REI");
  assert.strictEqual(cellOf(sheet, 2, "국가"), "미국");
  assert.strictEqual(cellOf(sheet, 2, "통화"), "USD");
  assert.strictEqual(cellOf(sheet, 2, "정가"), 199);
  assert.strictEqual(cellOf(sheet, 2, "판매가"), 149);
  assert.ok(Math.abs(cellOf(sheet, 2, "할인율") - 0.25) < 0.005, "할인율은 비율(0.25)로 넣어 서식이 %로 보이게 한다");
  assert.strictEqual(cellOf(sheet, 2, "사이즈"), "M / L");
  assert.strictEqual(cellOf(sheet, 2, "재고"), "재고 있음");
});

test("최종원가는 지금 cost.yaml 기준으로 다시 계산한다 (서버 계산과 일치)", async () => {
  const file = writeResult("cost.json", [item()]);
  const expected = landedCost(cfg, { price: 149, currency: "USD", marketCountry: "US", region: "US", category: "apparel", weight_kg: 0.8 }, "proxy");
  const { wb } = await build([file]);
  const sheet = wb.getWorksheet("상품");
  assert.strictEqual(cellOf(sheet, 2, "최종원가(원)"), expected.totalKrw);
  assert.strictEqual(cellOf(sheet, 2, "예상판매가(원)"), Math.round(expected.totalKrw * 1.6));

  const business = await build([file], { mode: "business", markup: 2 });
  const bSheet = business.wb.getWorksheet("상품");
  const bExpected = landedCost(cfg, { price: 149, currency: "USD", marketCountry: "US", region: "US", category: "apparel", weight_kg: 0.8 }, "business");
  assert.strictEqual(cellOf(bSheet, 2, "최종원가(원)"), bExpected.totalKrw, "--business 모드가 반영돼야 한다");
  assert.notStrictEqual(bExpected.totalKrw, expected.totalKrw);
});

test("영국(GB) 상품은 원가 칸을 비우고 사유를 적는다", async () => {
  const file = writeResult(
    "gb.json",
    [item({ sourceId: "end-gb", productId: "gb-1", brand: "END.", name: "Merino Jumper", currency: "GBP", salePrice: 120, listPrice: 180, marketCountry: "GB", region: null, sourceShop: "END. (GB)", sourceUrl: "https://www.endclothing.com/gb/p/1" })],
    [{ sourceId: "end-gb", sourceShop: "END. (GB)", marketCountry: "GB", status: "ok", complete: true, scope: { kind: "listing", value: null } }]
  );
  const { wb } = await build([file]);
  const sheet = wb.getWorksheet("상품");
  assert.strictEqual(cellOf(sheet, 2, "판매가"), 120, "원문 가격은 보존한다");
  assert.strictEqual(cellOf(sheet, 2, "통화"), "GBP");
  assert.strictEqual(cellOf(sheet, 2, "최종원가(원)"), null, "계산하지 않은 원가를 숫자로 채우면 안 된다");
  assert.match(String(cellOf(sheet, 2, "원가 비고")), /검증되지 않아|계산/);
});

test("여러 수집 파일을 합치고 중복은 한 번만 넣는다", async () => {
  const a = writeResult("a.json", [item(), item({ productId: "2", name: "Better Sweater", salePrice: 99, listPrice: 139 })]);
  const b = writeResult(
    "b.json",
    [item({ sourceId: "beams-jp", productId: "jp-1", brand: "BEAMS", name: "ウールコート", currency: "JPY", salePrice: 12800, listPrice: 12800, marketCountry: "JP", region: "JP", sourceShop: "BEAMS", sourceUrl: "https://www.beams.co.jp/item/1" })],
    [{ sourceId: "beams-jp", sourceShop: "BEAMS", marketCountry: "JP", status: "ok", complete: true, scope: { kind: "listing", value: null } }]
  );
  const { wb, rowCount } = await build([a, b, a]); // 같은 파일을 두 번 넣어도 중복되지 않아야 한다
  assert.strictEqual(rowCount, 3);

  const status = wb.getWorksheet("판매처 상태");
  assert.strictEqual(status.rowCount, 3, "판매처 상태는 소스별 한 줄");
  const summary = wb.getWorksheet("브랜드 요약");
  assert.strictEqual(summary.rowCount, 3, "브랜드 요약 = 헤더 + 파타고니아 + BEAMS");
});

test("판매처 상태 시트에 실패 진단이 한국어로 남는다", async () => {
  const file = writeResult(
    "fail.json",
    [item()],
    [
      { sourceId: "rei-us", sourceShop: "REI", marketCountry: "US", status: "ok", complete: true, scope: { kind: "listing", value: null }, accepted: 1 },
      { sourceId: "end-gb", sourceShop: "END. (GB)", marketCountry: "GB", status: "blocked", httpStatus: 403, complete: false, scope: { kind: "listing", value: null }, error: "봇 차단 화면" },
    ]
  );
  const { wb } = await build([file]);
  const status = wb.getWorksheet("판매처 상태");
  const blockedRow = status.getRow(3);
  assert.strictEqual(blockedRow.getCell(headerIndex(status, "상태")).value, "차단됨");
  assert.strictEqual(blockedRow.getCell(headerIndex(status, "HTTP")).value, 403);
  assert.strictEqual(blockedRow.getCell(headerIndex(status, "범위 완료")).value, "미완료");
});

test("--sale-only / --min-off 필터가 동작한다", async () => {
  const file = writeResult("filter.json", [
    item(),                                                        // 25% 할인
    item({ productId: "2", name: "정가 상품", salePrice: 100, listPrice: 100 }),
    item({ productId: "3", name: "반값 상품", salePrice: 50, listPrice: 100 }), // 50% 할인
  ]);
  const all = await build([file]);
  assert.strictEqual(all.rowCount, 3);

  const sale = await build([file], { saleOnly: true });
  assert.strictEqual(sale.rowCount, 2);

  const deep = await build([file], { minOff: 40 });
  assert.strictEqual(deep.rowCount, 1);
  assert.strictEqual(cellOf(deep.wb.getWorksheet("상품"), 2, "상품명"), "반값 상품");
});

test("상품 링크는 하이퍼링크로 들어가고 http(s)가 아니면 비운다", async () => {
  const file = writeResult("link.json", [
    item(),
    item({ productId: "bad", name: "나쁜 링크", sourceUrl: "https://www.rei.com/product/ok/1" }),
  ]);
  const { wb } = await build([file]);
  const sheet = wb.getWorksheet("상품");
  const cell = sheet.getRow(2).getCell(headerIndex(sheet, "상품링크"));
  assert.ok(cell.value && cell.value.hyperlink, "하이퍼링크여야 한다");
  assert.match(cell.value.hyperlink, /^https:\/\/www\.rei\.com\/product\//);
});

test("실행 정보 시트에 환율 기준일과 원본 파일이 남는다", async () => {
  const file = writeResult("info.json", [item()]);
  const { wb } = await build([file]);
  const info = wb.getWorksheet("실행 정보");
  const text = [];
  info.eachRow((row) => text.push(String(row.getCell(1).value) + "=" + String(row.getCell(2).value)));
  const joined = text.join("\n");
  assert.match(joined, /통관 모드=구매대행/);
  assert.match(joined, /환율 기준일=/);
  assert.match(joined, /원본 파일=info\.json \(1건\)/);
});

test("잘못된 수집 파일은 엑셀을 만들기 전에 거부한다", () => {
  const bad = path.join(tmpDir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ items: [{ name: "가격 없음" }] }));
  assert.throws(() => loadAndMerge([bad]), /bad\.json/);
  assert.throws(() => loadAndMerge([path.join(tmpDir, "없는파일.json")]), /찾을 수 없습니다/);
});
