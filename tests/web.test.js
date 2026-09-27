// 웹 화면 회귀 테스트 (리뷰 R09·R10·R12 / 검수 Q07·Q08·Q09·Q10·Q12)
// 실제 Chromium으로 web/index.html을 띄우되, 모든 요청을 가로채 fixture로 응답한다.
// 외부 네트워크는 쓰지 않는다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let chromium = null;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  chromium = null;
}

const { loadConfig, publicConfig, landedCost } = require("../api/_lib/landedCost");
const schema = require("../web/shared/schema.js");
const brandsLib = require("../web/shared/brands.js");
const ARCTERYX_ID = brandsLib.canonicalBrandId("Arc’teryx");

const ROOT = path.join(__dirname, "..");
const CFG = publicConfig(loadConfig());
const ORIGIN = "https://app.test";

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8" };

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
      sourceShop: "REI",
      sourceUrl: "https://www.rei.com/product/184879/nano-puff",
      imageUrls: [],
      availability: "in_stock",
      collectedAt: new Date().toISOString(),
    },
    over || {}
  );
}

function resultFile(items, srPatch) {
  return {
    schemaVersion: 2,
    runId: "test",
    collectedAt: new Date().toISOString(),
    sourceResults: [
      Object.assign(
        { sourceId: "rei-us", sourceShop: "REI", status: "ok", complete: true, scope: { kind: "brand", value: "patagonia" } },
        srPatch || {}
      ),
    ],
    items,
  };
}

function writeTmp(name, obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jiggu-")), name);
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return file;
}

async function openApp(t, opts) {
  const o = opts || {};
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext();
  const errors = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 204, body: "" });

    if (url.pathname === "/api/config") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ config: CFG, configAsOf: "2026-09-03" }) });
    }
    if (url.pathname === "/api/korea-price") {
      const body = o.korea ? o.korea(url) : { available: false, reason: "설정 필요" };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.pathname === "/api/scan") {
      const body = o.scan ? o.scan(url) : { items: [], sourceResults: [], errors: [], nextCursor: null, schemaVersion: 2 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = path.join(ROOT, "web", rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({
      status: 200,
      contentType: CONTENT_TYPES[path.extname(file)] || "text/plain",
      body: fs.readFileSync(file, "utf-8"),
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(ORIGIN + "/", { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#cfgStatus") && !/불러오는 중/.test(document.querySelector("#cfgStatus").textContent));
  return { browser, context, page, errors };
}

async function importFile(page, file) {
  // 이전 가져오기 결과 문구가 남아 있으면 완료 여부를 구분할 수 없다 — 먼저 비운다
  await page.evaluate(() => { document.querySelector("#importResult").textContent = ""; });
  await page.setInputFiles("#importFile", file);
  await page.waitForFunction(() => {
    const el = document.querySelector("#importResult");
    return el && el.style.display === "block" && el.textContent.length > 0;
  });
  return page.textContent("#importResult");
}

const itemNames = (page) => page.$$eval(".pitem .pname", (els) => els.map((e) => e.textContent));

test("웹 화면 회귀 (Q07~Q10)", { concurrency: false }, async (t) => {
  if (!chromium) return t.skip("playwright 미설치");
  let app;
  try {
    app = await openApp(t);
  } catch (e) {
    return t.skip("chromium 실행 불가: " + e.message);
  }
  const { browser, page, errors } = app;

  try {
    await t.test("Q07 - REI Patagonia 뒤에 REI Arc'teryx를 가져와도 앞 상품이 남는다", async () => {
      const f1 = writeTmp("patagonia.json", resultFile([item()], { scope: { kind: "brand", value: "patagonia" } }));
      const f2 = writeTmp(
        "arcteryx.json",
        resultFile([item({ productId: "235803", brand: "Arc’teryx", name: "Beta LT Jacket", salePrice: 399, listPrice: 499 })], {
          scope: { kind: "brand", value: "arcteryx" },
        })
      );
      await importFile(page, f1);
      await importFile(page, f2);
      const names = await itemNames(page);
      assert.strictEqual(names.length, 2, "다른 브랜드 수집 결과가 서로를 지우면 안 된다: " + JSON.stringify(names));
      assert.ok(names.some((n) => n.includes("Nano Puff")));
      assert.ok(names.some((n) => n.includes("Beta LT")));
    });

    await t.test("Q07 - 같은 파일을 다시 가져와도 중복되지 않는다", async () => {
      const f1 = writeTmp("patagonia.json", resultFile([item()], { scope: { kind: "brand", value: "patagonia" } }));
      await importFile(page, f1);
      const names = await itemNames(page);
      assert.strictEqual(names.length, 2);
    });

    await t.test("Q08 - 잘못된 파일은 거부하고 기존 데이터를 유지한다", async () => {
      const bad = writeTmp("bad.json", { items: [{ name: "가격 없음" }] });
      const msg = await importFile(page, bad);
      assert.match(msg, /가져오기 실패/);
      assert.strictEqual((await itemNames(page)).length, 2, "실패한 가져오기가 기존 상품을 지우면 안 된다");

      const broken = writeTmp("broken.json", "{not json");
      const msg2 = await importFile(page, broken);
      assert.match(msg2, /가져오기 실패/);
      assert.strictEqual((await itemNames(page)).length, 2);
    });

    await t.test("Q10 - 화면 원가가 서버 계산과 일치한다", async () => {
      const expected = landedCost(
        loadConfig(),
        { price: 149, currency: "USD", marketCountry: "US", region: "US", category: "apparel", weight_kg: 0.8 },
        "proxy"
      );
      const shown = await page.$$eval(".pitem", (els) =>
        els.map((e) => ({ name: e.querySelector(".pname").textContent, krw: e.querySelector(".krw").textContent }))
      );
      const nano = shown.find((s) => s.name.includes("Nano Puff"));
      assert.ok(nano, "상품이 보여야 한다");
      assert.ok(
        nano.krw.includes(Math.round(expected.totalKrw).toLocaleString("ko-KR")),
        `화면 ${nano.krw} / 서버 ${expected.totalKrw}`
      );
    });

    await t.test("Q10 - 영국(GB) 상품은 '원가 계산 미완료'로 표시된다", async () => {
      const gb = writeTmp(
        "gb.json",
        resultFile(
          [
            item({
              sourceId: "end-gb",
              productId: "gb-1",
              brand: "END.",
              name: "Merino Jumper",
              currency: "GBP",
              salePrice: 120,
              listPrice: 180,
              marketCountry: "GB",
              region: null,
              sourceShop: "END. (GB)",
              sourceUrl: "https://www.endclothing.com/gb/p/1",
            }),
          ],
          { sourceId: "end-gb", sourceShop: "END. (GB)", scope: { kind: "listing", value: null } }
        )
      );
      await importFile(page, gb);
      const shown = await page.$$eval(".pitem", (els) =>
        els.map((e) => ({ name: e.querySelector(".pname").textContent, krw: e.querySelector(".krw").textContent }))
      );
      const uk = shown.find((s) => s.name.includes("Merino"));
      assert.ok(uk, "영국 상품도 목록에 남아야 한다(가격은 원문 보존)");
      assert.match(uk.krw, /원가 계산 미완료/);
    });

    await t.test("Q09 - 상품명·URL의 악성 문자열이 실행되지 않는다", async () => {
      const evil = writeTmp(
        "evil.json",
        resultFile(
          [
            item({
              productId: "evil-1",
              name: '<img src=x onerror="window.__pwned=1">',
              brand: "Patagonia",
              sourceUrl: "https://www.rei.com/product/evil/1",
              imageUrls: ["javascript:window.__pwned=2"],
            }),
          ],
          { scope: { kind: "brand", value: "evil" } }
        )
      );
      await importFile(page, evil);
      const names = await itemNames(page);
      assert.ok(names.some((n) => n.includes("<img src=x")), "HTML은 텍스트로 표시돼야 한다");
      assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, "코드가 실행되면 안 된다");
      assert.strictEqual(await page.$$eval(".pitem img", (els) => els.length), 0, "javascript: 이미지가 렌더링되면 안 된다");
    });

    await t.test("Q08 - 새로고침 후에도 가져온 상품이 복원된다", async () => {
      const before = (await itemNames(page)).length;
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => document.querySelectorAll(".pitem").length > 0);
      const after = (await itemNames(page)).length;
      assert.strictEqual(after, before, "IndexedDB에서 복원돼야 한다");
    });

    await t.test("Q12 - 국가·판매처 필터가 브랜드와 함께 동작한다", async () => {
      await page.click('nav button[data-view="v-items"]'); // 상품 탭으로 이동
      await page.selectOption("#fCountrySel", "GB");
      await page.waitForFunction(() => document.querySelectorAll(".pitem").length === 1);
      assert.ok((await itemNames(page))[0].includes("Merino"));

      await page.selectOption("#fCountrySel", "");
      await page.selectOption("#fSourceSel", "rei-us");
      await page.waitForFunction(() => document.querySelectorAll(".pitem").length >= 2);
      const names = await itemNames(page);
      assert.ok(!names.some((n) => n.includes("Merino")), "판매처 필터가 적용돼야 한다");

      await page.selectOption("#fSourceSel", "");
      await page.selectOption("#fBrandSel", ARCTERYX_ID);
      await page.waitForFunction(() => document.querySelectorAll(".pitem").length === 1);
      assert.ok((await itemNames(page))[0].includes("Beta LT"));
      await page.selectOption("#fBrandSel", "");
    });

    await t.test("Q12 - 상품 상세와 게시글이 만들어진다", async () => {
      await page.selectOption("#fBrandSel", "patagonia");
      await page.waitForFunction(() => document.querySelectorAll(".pitem").length >= 1);
      await page.click(".pitem");
      await page.waitForSelector("#sheet.on");
      const title = await page.inputValue("#postTitle");
      assert.match(title, /\[해외직구\] 파타고니아/);
      const body = await page.inputValue("#postBody");
      assert.match(body, /구입처 : REI/);
      await page.click("#shClose");
      await page.selectOption("#fBrandSel", "");
    });

    assert.deepStrictEqual(errors, [], "콘솔/페이지 오류가 없어야 한다");
  } finally {
    await browser.close();
  }
});

test("웹 스캔 — cursor를 끝까지 이어받고 부분 실패에도 기존 데이터를 지키지 않는다 (Q01·Q02)", { concurrency: false }, async (t) => {
  if (!chromium) return t.skip("playwright 미설치");

  const calls = [];
  const scan = (url) => {
    const cursor = url.searchParams.get("cursor");
    calls.push(cursor || "(first)");
    if (!cursor) {
      return {
        schemaVersion: 2,
        collectedAt: new Date().toISOString(),
        chunk: true,
        nextCursor: "rei-us:2",
        plannedSources: [{ sourceId: "rei-us", shopName: "REI" }],
        sourceResults: [{ sourceId: "rei-us", sourceShop: "REI", status: "ok", scope: { kind: "listing", value: null }, accepted: 1 }],
        items: [item({ productId: "p1", name: "Page One Item" })],
        errors: [],
        fxRates: { USD: 1380, EUR: 1490, JPY: 9.2 },
      };
    }
    return {
      schemaVersion: 2,
      collectedAt: new Date().toISOString(),
      chunk: true,
      nextCursor: null,
      plannedSources: [{ sourceId: "rei-us", shopName: "REI" }],
      sourceResults: [
        { sourceId: "rei-us", sourceShop: "REI", status: "rate_limited", httpStatus: 429, scope: { kind: "listing", value: null }, error: "HTTP 429" },
      ],
      items: [],
      errors: [{ sourceId: "rei-us", brand: "REI", domain: "www.rei.com", status: "rate_limited", httpStatus: 429, error: "HTTP 429" }],
      fxRates: { USD: 1380, EUR: 1490, JPY: 9.2 },
    };
  };

  let app;
  try {
    app = await openApp(t, { scan });
  } catch (e) {
    return t.skip("chromium 실행 불가: " + e.message);
  }
  const { browser, page } = app;
  try {
    // PC에서 가져온 상품이 이미 있는 상태
    const pcFile = writeTmp("pc.json", resultFile([item({ sourceId: "beams-jp", productId: "jp-1", sourceShop: "BEAMS", name: "PC 수집 상품", currency: "JPY", salePrice: 12800, listPrice: 12800, marketCountry: "JP", region: "JP", sourceUrl: "https://www.beams.co.jp/item/1" })], { sourceId: "beams-jp", sourceShop: "BEAMS" }));
    await importFile(page, pcFile);
    assert.strictEqual((await itemNames(page)).length, 1);

    await page.click('nav button[data-view="v-items"]');
    await page.click("#dropConfirmBtn");
    await page.waitForFunction(() => document.querySelectorAll(".pitem").length === 2);

    assert.deepStrictEqual(calls, ["(first)", "rei-us:2"], "nextCursor를 끝까지 소비해야 한다");
    const names = await itemNames(page);
    assert.ok(names.some((n) => n.includes("PC 수집 상품")), "스캔 부분 실패가 PC 수집 상품을 지우면 안 된다");
    assert.ok(names.some((n) => n.includes("Page One Item")));

    // 실패 진단이 화면에 남는다
    const toggle = await page.textContent("#prodErrToggle");
    assert.match(toggle, /실패 목록 보기/);
    await page.click("#prodErrToggle");
    const errText = await page.textContent("#prodErrList");
    assert.match(errText, /rate_limited/);
  } finally {
    await browser.close();
  }
});

test("상품 검색 — 브랜드+상품명으로 정가 상품까지 찾고 국내가와 비교한다", { concurrency: false }, async (t) => {
  if (!chromium) return t.skip("playwright 미설치");

  const scanCalls = [];
  const koreaCalls = [];
  const scan = (url) => {
    scanCalls.push(Object.fromEntries(url.searchParams));
    return {
      schemaVersion: 2,
      collectedAt: new Date().toISOString(),
      chunk: true,
      nextCursor: null,
      plannedSources: [{ sourceId: "rei-us", shopName: "REI" }],
      sourceResults: [{ sourceId: "rei-us", sourceShop: "REI", status: "ok", scope: { kind: "search", value: "patagonia|retro" }, accepted: 2 }],
      items: [
        item({ productId: "r1", name: "Classic Retro-X Fleece Jacket", salePrice: 299, listPrice: 299 }),
        item({ productId: "r2", name: "Retro Pile Vest", salePrice: 99, listPrice: 139 }),
      ],
      errors: [],
      fxRates: { USD: 1380, EUR: 1490, JPY: 9.2 },
    };
  };
  const korea = (url) => {
    const q = url.searchParams.get("q");
    koreaCalls.push(q);
    // 레트로X는 국내가 비싸고(해외가 저렴), 파일 베스트는 국내가 아주 싸다
    const cheapest = /Retro-X/.test(q) ? 900000 : 10000;
    return {
      available: true, query: q, usedQuery: q, shortened: false, confidence: "low",
      results: [{ title: "국내 상품", priceKrw: cheapest, mallName: "몰", link: "https://shopping.naver.com/x" }],
      cheapestKrw: cheapest, medianKrw: cheapest,
    };
  };

  let app;
  try {
    app = await openApp(t, { scan, korea });
  } catch (e) {
    return t.skip("chromium 실행 불가: " + e.message);
  }
  const { browser, page, errors } = app;
  try {
    await page.click('nav button[data-view="v-items"]');

    // 한글 상품명은 서버로 보내지 않고 안내한다
    await page.fill("#q", "파타고니아 레트로");
    await page.press("#q", "Enter");
    await page.waitForFunction(() => /영문/.test(document.querySelector("#toast").textContent));
    assert.strictEqual(scanCalls.length, 0);

    // 브랜드 없이 상품명만이면 서버를 부르지 않는다
    await page.fill("#q", "retro");
    await page.press("#q", "Enter");
    await page.waitForFunction(() => /브랜드를 함께/.test(document.querySelector("#toast").textContent));
    assert.strictEqual(scanCalls.length, 0);

    await page.fill("#q", "파타고니아 retro");
    await page.press("#q", "Enter");
    await page.waitForFunction(() => document.querySelectorAll(".pitem").length === 2);
    assert.strictEqual(scanCalls.length, 1);
    assert.strictEqual(scanCalls[0].brand, "patagonia");
    assert.strictEqual(scanCalls[0].q, "retro");
    assert.strictEqual(scanCalls[0].scope, undefined, "세일 스캔이 아니다");

    // 국내가 비교 → 카드에 차액이 붙고, 국내가 대비 저렴순으로 정렬된다
    await page.click("#krCompareBtn");
    await page.waitForFunction(() => document.querySelectorAll(".pitem .kr").length === 2);
    assert.strictEqual(koreaCalls.length, 2);
    await page.selectOption("#fSortSel", "kr");
    const first = await page.$eval(".pitem", (e) => ({ name: e.querySelector(".pname").textContent, kr: e.querySelector(".kr").className }));
    assert.match(first.name, /Retro-X/);
    assert.match(first.kr, /cheaper/);
    const krTexts = await page.$$eval(".pitem .kr", (els) => els.map((e) => e.textContent));
    assert.ok(krTexts.some((x) => /국내가 .*더 쌈/.test(x)));

    // 상세는 캐시를 재사용하고, 검색어를 바꿔 다시 찾을 수 있다
    await page.click(".pitem");
    await page.waitForFunction(() => /저렴합니다/.test(document.querySelector("#shKorea").textContent));
    assert.strictEqual(koreaCalls.length, 2, "이미 비교한 상품은 다시 조회하지 않는다");
    await page.fill("#krQuery", "파타고니아 레트로X");
    await page.click("#krSearchBtn");
    await page.waitForFunction(() => /파타고니아 레트로X/.test(document.querySelector("#shKorea").textContent));
    assert.strictEqual(koreaCalls[2], "파타고니아 레트로X");

    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
  }
});
