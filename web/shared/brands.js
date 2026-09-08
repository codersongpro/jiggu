/* 브랜드 정본(canonical) 목록 — 브라우저/Node 공용
 *
 * 예전에는 화면의 브랜드 칩(한글)·드롭다운(영문 key)·검색 별칭이 서로 다른 표를 봐서
 * "스탠스"로 검색한 결과와 드롭다운 Stance 결과가 달랐다(리뷰 R12).
 * 브랜드 식별은 여기 있는 id 하나로 통일한다.
 *
 *   id      : 안정적인 canonical ID (URL/CLI/필터에서 쓰는 값)
 *   en      : 영문 표기 (Shopify vendor 등 원문과 대조)
 *   kr      : 한글 표기 (화면 표시)
 *   aliases : 검색·CLI에서 허용하는 별칭
 *
 * 판매처(구입처) 이름과 브랜드는 다르다. 편집숍은 config/targets.json의 sourceId로,
 * 실제 제조사 브랜드는 이 표의 id로 관리한다.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguBrands = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BRANDS = [
    {
      "id": "allbirds",
      "en": "Allbirds",
      "kr": "올버즈",
      "aliases": []
    },
    {
      "id": "allsaints",
      "en": "AllSaints",
      "kr": "올세인츠",
      "aliases": [
        "올세인트",
        "all saints"
      ]
    },
    {
      "id": "anine-bing",
      "en": "Anine Bing",
      "kr": "아닌빙",
      "aliases": []
    },
    {
      "id": "arc-teryx",
      "en": "Arc’teryx",
      "kr": "아크테릭스",
      "aliases": [
        "아크",
        "arcteryx",
        "arc teryx"
      ]
    },
    {
      "id": "aritzia",
      "en": "Aritzia",
      "kr": "아리치아",
      "aliases": []
    },
    {
      "id": "bandier",
      "en": "Bandier",
      "kr": "밴디어",
      "aliases": []
    },
    {
      "id": "barbour",
      "en": "Barbour",
      "kr": "바버",
      "aliases": []
    },
    {
      "id": "birdies",
      "en": "Birdies",
      "kr": "버디스",
      "aliases": []
    },
    {
      "id": "bodega",
      "en": "Bodega",
      "kr": "보데가",
      "aliases": []
    },
    {
      "id": "bombas",
      "en": "Bombas",
      "kr": "봄바스",
      "aliases": []
    },
    {
      "id": "carbon38",
      "en": "Carbon38",
      "kr": "카본38",
      "aliases": []
    },
    {
      "id": "carhartt-wip",
      "en": "Carhartt WIP",
      "kr": "칼하트",
      "aliases": [
        "carhartt"
      ]
    },
    {
      "id": "chubbies",
      "en": "Chubbies",
      "kr": "처비스",
      "aliases": []
    },
    {
      "id": "coach",
      "en": "Coach",
      "kr": "코치",
      "aliases": []
    },
    {
      "id": "coach-outlet",
      "en": "Coach Outlet",
      "kr": "코치 아울렛",
      "aliases": []
    },
    {
      "id": "concepts",
      "en": "Concepts",
      "kr": "콘셉츠",
      "aliases": []
    },
    {
      "id": "cos",
      "en": "COS",
      "kr": "코스",
      "aliases": []
    },
    {
      "id": "cotopaxi",
      "en": "Cotopaxi",
      "kr": "코토팍시",
      "aliases": []
    },
    {
      "id": "cuyana",
      "en": "Cuyana",
      "kr": "쿠야나",
      "aliases": []
    },
    {
      "id": "faherty",
      "en": "Faherty",
      "kr": "파허티",
      "aliases": []
    },
    {
      "id": "fashion-nova",
      "en": "Fashion Nova",
      "kr": "패션노바",
      "aliases": []
    },
    {
      "id": "ferragamo",
      "en": "Ferragamo",
      "kr": "페라가모",
      "aliases": []
    },
    {
      "id": "free-people",
      "en": "Free People",
      "kr": "프리피플",
      "aliases": []
    },
    {
      "id": "ganni",
      "en": "Ganni",
      "kr": "가니",
      "aliases": []
    },
    {
      "id": "ganni-eu",
      "en": "Ganni EU",
      "kr": "가니",
      "aliases": []
    },
    {
      "id": "girlfriend-collective",
      "en": "Girlfriend Collective",
      "kr": "걸프렌드컬렉티브",
      "aliases": []
    },
    {
      "id": "golden-goose",
      "en": "Golden Goose",
      "kr": "골든구스",
      "aliases": [
        "골구"
      ]
    },
    {
      "id": "goop",
      "en": "Goop",
      "kr": "굽",
      "aliases": []
    },
    {
      "id": "gymshark",
      "en": "Gymshark",
      "kr": "짐샤크",
      "aliases": []
    },
    {
      "id": "hoka",
      "en": "Hoka",
      "kr": "호카",
      "aliases": []
    },
    {
      "id": "isabel-marant",
      "en": "Isabel Marant",
      "kr": "이자벨마랑",
      "aliases": [
        "이자벨"
      ]
    },
    {
      "id": "kate-spade",
      "en": "Kate Spade",
      "kr": "케이트스페이드",
      "aliases": [
        "케이트"
      ]
    },
    {
      "id": "kate-spade-outlet",
      "en": "Kate Spade Outlet",
      "kr": "케이트스페이드 아울렛",
      "aliases": []
    },
    {
      "id": "kirna-zabete",
      "en": "Kirna Zabete",
      "kr": "키르나자베트",
      "aliases": []
    },
    {
      "id": "kith",
      "en": "Kith",
      "kr": "키스",
      "aliases": []
    },
    {
      "id": "kotn",
      "en": "Kotn",
      "kr": "코튼",
      "aliases": []
    },
    {
      "id": "lacoste",
      "en": "Lacoste",
      "kr": "라코스테",
      "aliases": [
        "라코"
      ]
    },
    {
      "id": "longchamp",
      "en": "Longchamp",
      "kr": "롱샴",
      "aliases": []
    },
    {
      "id": "lululemon",
      "en": "Lululemon",
      "kr": "룰루레몬",
      "aliases": [
        "룰루"
      ]
    },
    {
      "id": "m-gemi",
      "en": "M.Gemi",
      "kr": "엠제미",
      "aliases": [
        "mgemi"
      ]
    },
    {
      "id": "maje",
      "en": "Maje",
      "kr": "마쥬",
      "aliases": [
        "마제"
      ]
    },
    {
      "id": "maje-eu",
      "en": "Maje EU",
      "kr": "마쥬",
      "aliases": []
    },
    {
      "id": "marc-jacobs",
      "en": "Marc Jacobs",
      "kr": "마크제이콥스",
      "aliases": [
        "마크제이"
      ]
    },
    {
      "id": "marine-layer",
      "en": "Marine Layer",
      "kr": "마린레이어",
      "aliases": []
    },
    {
      "id": "max-mara",
      "en": "Max Mara",
      "kr": "막스마라",
      "aliases": [
        "맥스마라",
        "maxmara"
      ]
    },
    {
      "id": "meundies",
      "en": "MeUndies",
      "kr": "미언디스",
      "aliases": []
    },
    {
      "id": "michael-kors",
      "en": "Michael Kors",
      "kr": "마이클코어스",
      "aliases": [
        "마이클"
      ]
    },
    {
      "id": "mvmt",
      "en": "MVMT",
      "kr": "무브먼트",
      "aliases": []
    },
    {
      "id": "naadam",
      "en": "Naadam",
      "kr": "나담",
      "aliases": []
    },
    {
      "id": "nasty-gal",
      "en": "Nasty Gal",
      "kr": "나스티갤",
      "aliases": []
    },
    {
      "id": "new-balance",
      "en": "New Balance",
      "kr": "뉴발란스",
      "aliases": [
        "뉴발"
      ]
    },
    {
      "id": "on-running",
      "en": "On Running",
      "kr": "온러닝",
      "aliases": [
        "on cloud"
      ]
    },
    {
      "id": "outdoor-voices",
      "en": "Outdoor Voices",
      "kr": "아웃도어보이시스",
      "aliases": []
    },
    {
      "id": "patagonia",
      "en": "Patagonia",
      "kr": "파타고니아",
      "aliases": [
        "파타"
      ]
    },
    {
      "id": "polo-ralph-lauren",
      "en": "Polo Ralph Lauren",
      "kr": "폴로 랄프로렌",
      "aliases": [
        "폴로랄프로렌",
        "랄프로렌",
        "랄프",
        "ralph lauren",
        "polo ralph"
      ]
    },
    {
      "id": "princess-polly",
      "en": "Princess Polly",
      "kr": "프린세스폴리",
      "aliases": []
    },
    {
      "id": "rebecca-minkoff",
      "en": "Rebecca Minkoff",
      "kr": "레베카민코프",
      "aliases": []
    },
    {
      "id": "reformation",
      "en": "Reformation",
      "kr": "레포메이션",
      "aliases": []
    },
    {
      "id": "reiss",
      "en": "Reiss",
      "kr": "리스",
      "aliases": []
    },
    {
      "id": "rothy-s",
      "en": "Rothy’s",
      "kr": "로시스",
      "aliases": [
        "rothys",
        "rothy"
      ]
    },
    {
      "id": "rouje",
      "en": "Rouje",
      "kr": "루쥬",
      "aliases": []
    },
    {
      "id": "rowing-blazers",
      "en": "Rowing Blazers",
      "kr": "로잉블레이저스",
      "aliases": []
    },
    {
      "id": "salomon",
      "en": "Salomon",
      "kr": "살로몬",
      "aliases": []
    },
    {
      "id": "sandro",
      "en": "Sandro",
      "kr": "산드로",
      "aliases": []
    },
    {
      "id": "sandro-eu",
      "en": "Sandro EU",
      "kr": "산드로",
      "aliases": []
    },
    {
      "id": "self-portrait",
      "en": "Self-Portrait",
      "kr": "셀프포트레이트",
      "aliases": []
    },
    {
      "id": "sezane",
      "en": "Sezane",
      "kr": "세잔느",
      "aliases": []
    },
    {
      "id": "stance",
      "en": "Stance",
      "kr": "스탠스",
      "aliases": []
    },
    {
      "id": "staud",
      "en": "Staud",
      "kr": "스토드",
      "aliases": []
    },
    {
      "id": "stussy",
      "en": "Stussy",
      "kr": "스투시",
      "aliases": []
    },
    {
      "id": "taylor-stitch",
      "en": "Taylor Stitch",
      "kr": "테일러스티치",
      "aliases": []
    },
    {
      "id": "the-webster",
      "en": "The Webster",
      "kr": "더웹스터",
      "aliases": []
    },
    {
      "id": "theory",
      "en": "Theory",
      "kr": "띠어리",
      "aliases": [
        "시어리"
      ]
    },
    {
      "id": "thirdlove",
      "en": "ThirdLove",
      "kr": "써드러브",
      "aliases": []
    },
    {
      "id": "tory-burch",
      "en": "Tory Burch",
      "kr": "토리버치",
      "aliases": [
        "토리"
      ]
    },
    {
      "id": "ugg",
      "en": "Ugg",
      "kr": "어그",
      "aliases": []
    },
    {
      "id": "untuckit",
      "en": "Untuckit",
      "kr": "언턱잇",
      "aliases": []
    },
    {
      "id": "veja",
      "en": "Veja",
      "kr": "베자",
      "aliases": []
    },
    {
      "id": "verishop",
      "en": "Verishop",
      "kr": "베리샵",
      "aliases": []
    },
    {
      "id": "vince",
      "en": "Vince",
      "kr": "빈스",
      "aliases": []
    },
    {
      "id": "vuori",
      "en": "Vuori",
      "kr": "부오리",
      "aliases": []
    },
    {
      "id": "zadig-voltaire",
      "en": "Zadig&Voltaire",
      "kr": "쟈딕앤볼테르",
      "aliases": [
        "자딕앤볼테르",
        "쟈딕",
        "자딕",
        "zadig"
      ]
    },
    {
      "id": "zadig-voltaire-eu",
      "en": "Zadig&Voltaire EU",
      "kr": "쟈딕앤볼테르",
      "aliases": []
    }
  ];

  const byId = new Map();
  const lookup = new Map(); // 정규화한 문자열 → id

  const normalize = (s) =>
    String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[\s._`-]/g, "")
      .replace(/&/g, "and")
      .trim();

  for (const b of BRANDS) {
    byId.set(b.id, b);
    [b.id, b.en, b.kr, ...(b.aliases || [])].forEach((key) => {
      const k = normalize(key);
      if (k && !lookup.has(k)) lookup.set(k, b.id);
    });
  }

  /** 입력이 무엇이든(id/영문/한글/별칭) canonical id로 바꾼다. 모르면 null. */
  function canonicalBrandId(input) {
    const k = normalize(input);
    if (!k) return null;
    return lookup.get(k) || null;
  }

  /** 등록되지 않은 브랜드(편집숍의 vendor 등)도 다루기 위한 id 생성 */
  function toBrandId(input) {
    const known = canonicalBrandId(input);
    if (known) return known;
    const slug = String(input == null ? "" : input)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-|-$/g, "");
    return slug || null;
  }

  function getBrand(id) {
    return byId.get(id) || null;
  }

  /** 화면 표시용 이름 — 등록 브랜드는 한글, 아니면 원문 그대로 */
  function brandLabel(idOrName, fallbackName) {
    const b = byId.get(idOrName) || byId.get(canonicalBrandId(idOrName));
    if (b) return b.kr || b.en;
    return fallbackName || String(idOrName || "");
  }

  function brandEnglish(idOrName, fallbackName) {
    const b = byId.get(idOrName) || byId.get(canonicalBrandId(idOrName));
    return b ? b.en : fallbackName || String(idOrName || "");
  }

  /** 두 브랜드 표기가 같은 브랜드인지 (vendor 원문 vs 필터값 비교용) */
  function sameBrand(a, b) {
    const ca = canonicalBrandId(a) || normalize(a);
    const cb = canonicalBrandId(b) || normalize(b);
    return !!ca && ca === cb;
  }

  function allBrands() {
    return BRANDS.slice();
  }

  return { BRANDS, allBrands, canonicalBrandId, toBrandId, getBrand, brandLabel, brandEnglish, sameBrand, normalize };
});
