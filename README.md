# 해외의류 소싱 크롤러 — 핫딜 레이더

가족용 해외 세일 감지 + 원가 계산 + 게시글 생성 도구. Vercel에 배포해 스마트폰에서
스캔 버튼을 누르면 등록된 브랜드몰들을 실시간으로 조회해 세일 상품을 정리해 준다.

## 폴더 구조

```
├── CLAUDE.md               프로젝트 맥락 (Claude Code가 먼저 읽음)
├── PRD.md                  설계 문서
├── docs/
│   ├── CRAWLING_REVIEW_AND_IMPROVEMENT_PLAN.md  코드 리뷰·개선 계획(작업 명세)
│   └── VERIFICATION.md      무엇을 실제로 검증했고 무엇이 미검증인지
├── config/
│   ├── cost.yaml            관세·환율·배대지·수수료·시장(markets) 설정
│   └── targets.json         판매처 정본 목록 (서버 스캔·PC 수집기·웹이 공통으로 읽음)
├── web/
│   ├── index.html            모바일 프론트 (정적, Vercel이 그대로 서빙)
│   └── shared/               서버·PC·브라우저 공용 모듈 (계산·정규화·병합)
│       ├── money.js  통화·숫자 파싱      ├── offers.js  옵션별 가격/재고
│       ├── urls.js   URL 검증·정규화     ├── schema.js  수집 결과 계약(v2)
│       ├── brands.js 브랜드 정본         ├── merge.js   병합·조각 누적
│       ├── sources.js 판매처 목록        └── cost.js    원가 계산(순수)
├── api/
│   ├── scan.js               Vercel 서버리스 — 조각(cursor) 단위 스캔
│   ├── config.js             GET /api/config — 브라우저용 계산 설정(비밀값 없음)
│   ├── korea-price.js        국내 시세 온디맨드 조회 (네이버쇼핑)
│   └── _lib/                 landedCost.js(서버 래퍼) · shopify.js(products.json 정규화)
├── crawlers/                 수집 어댑터 (jsonld / links / generic-jsonld / rei-us)
├── scripts/
│   ├── local-crawler/crawl.js  PC 브라우저 수집기 (Playwright)
│   ├── feed-import/            어필리에이트 상품 피드 변환기
│   └── export-excel.js         수집 결과 → 엑셀(.xlsx) 정리
├── core/landed_cost.py       원가 계산 엔진 (Python, 참고/검증용)
├── tests/                    회귀 테스트 (node --test, 네트워크 미사용)
└── vercel.json / package.json
```

## Vercel 배포

1. 이 저장소를 GitHub에 올리고 [vercel.com](https://vercel.com)에서 Import
2. 빌드 설정은 건드릴 필요 없음 (`vercel.json`이 정적 파일 위치와 함수 설정을 지정)
3. Deploy 누르면 끝 — 별도 환경변수나 DB 설정 없이 바로 동작한다

배포되면 `/`가 `web/index.html`을, `/api/scan`이 스캔 함수를 서빙한다.

### 사용 흐름 — Sale중 탭과 상품탭은 서로 다른 스캔이다

| 탭 | 트리거 | 대상 | 갱신되는 것 |
|---|---|---|---|
| **Sale중** | 헤더 우측 "스캔" 버튼 | `config/targets.json`의 `popular: true` 판매처 | 세일 신호만. 상품탭은 안 건드림 |
| **상품** | 상품탭 "확인" 버튼 | 선택한 브랜드/국가/판매처 조건에 맞는 판매처 | 상품 목록만. Sale중은 안 건드림 |

필터(브랜드·국가·판매처·종류·가격대)는 **이미 가져온 상품에 즉시 적용**되고, '확인'을 누르면
그 조건으로 서버에서 새로 가져온다.

#### 스캔은 조각(chunk) 단위다

`/api/scan` 한 번의 호출은 **판매처 한 곳의 목록 한 페이지**만 처리하고 다음 위치를
`nextCursor`로 돌려준다. 화면이 cursor를 따라가며 결과를 누적하고, **처음부터 끝까지
오류 없이 이어받은 범위만** "완전 수집"으로 확정한다. 그래서 중간에 한 곳이 실패해도
기존 목록(특히 PC에서 가져온 상품)이 지워지지 않는다.

기존 파라미터(`brand`, `mode`, `onlyPopular`)와 응답 필드(`items`, `errors`, `fxRates`,
`sitesTotal/sitesOk/sitesFailed`)는 그대로 쓴다. `sites*`는 "이번 조각에서 처리한 소스 수"다.

| 파라미터 | 뜻 |
|---|---|
| `brand` | 브랜드 ID/영문/한글. 그 브랜드 공식몰 + 편집숍만 조회한다 |
| `marketCountry` | 시장(국가) 코드로 판매처를 좁힌다 |
| `sourceId` | 판매처 하나만 조회한다 (그 안에서만 페이지 진행) |
| `cursor` | 이전 응답의 `nextCursor`. 등록된 sourceId와 페이지 번호만 받는다 |
| `mode` | `proxy`(기본) / `business` |
| `onlyPopular` | `1`이면 Sale중 탭 대상만 |

### PC 수집기와 제휴 피드

Shopify `products.json`이 없거나 서버 요청이 막히는 판매처는 두 경로로 처리한다.

```bash
npm ci && npx playwright install chromium
npm run crawl -- --source rei-us --limit 20 --output output/rei-us.json      # PC 브라우저 수집
npm run feed-import -- ~/Downloads/coach-feed.csv --brand "Coach"            # 제휴 피드 변환
```

만들어진 JSON을 앱 **설정 탭 → 수집 결과 가져오기**에서 열면 상품 탭에 합쳐진다.
자세한 내용은 `scripts/local-crawler/README.md`, `scripts/feed-import/README.md` 참고.

### 엑셀로 정리하기

수집 결과 JSON을 엑셀(.xlsx) 한 파일로 정리한다. 여러 파일을 한 번에 넣으면 합쳐서 정리한다.

```bash
npm run excel -- output/rei-us.json
npm run excel -- output/rei-us.json output/jp.json --output output/소싱목록.xlsx
npm run excel -- output/rei-us.json --business --markup 1.8 --sale-only --min-off 40

npm run crawl -- --source rei-us --limit 20 --xlsx   # 수집하면서 바로 엑셀까지
```

| 시트 | 내용 |
|---|---|
| **상품** | 브랜드(한글/영문)·상품명·판매처·국가·통화·정가·판매가·할인율·최종원가·예상판매가·관세·재고·사이즈·색상·SKU·수집시각·상품링크. 할인율 높은 순 정렬, 40% 이상은 빨간 굵은 글씨, 상품링크는 클릭 가능 |
| **판매처 상태** | 판매처별 상태(정상/차단됨/요청 제한/주소 없음…)·범위 완료 여부·발견/조회/정상/제외 건수·HTTP·오류 |
| **브랜드 요약** | 브랜드별 상품 수·세일 수·최고/평균 할인율·최저 원가·판매처 |
| **실행 정보** | 통관 모드·판매가 배수·환율과 기준일·원본 파일·주의사항 |

원가는 파일에 저장된 값이 아니라 **지금의 `config/cost.yaml` 기준으로 다시 계산**한다.
환율이나 통관 모드를 바꾸고 다시 돌리면 그 기준으로 나온다. 세금·배대지 조건이 검증되지
않은 시장(영국 등)은 원가 칸을 비우고 '원가 비고'에 사유를 적는다 — 빈칸을 0으로 착각해
쓰지 않도록 일부러 채우지 않는다.

### 판매처 상태 (`config/targets.json`의 `support.status`)

| 값 | 뜻 |
|---|---|
| `supported` | **실제 수집 결과로 확인됨** (확인일·실행 환경이 함께 기록된다) |
| `unverified` | 아직 확인되지 않음 — 등록만 된 상태 |
| `blocked` | 실제 요청이 막힘(403/404/410/캡차 등). 스캔 대상에서 제외된다 |

등록만으로 `supported`로 올리지 않는다. 무엇이 검증됐는지는 `docs/VERIFICATION.md`에 있다.

### 국내 시세 비교(선택 사항)를 쓰려면

상품 상세를 열면 "국내 시세 비교" 섹션이 뜨는데, 이건 네이버쇼핑 검색 API를 쓴다. 키를
설정하지 않으면 이 섹션만 "설정 필요" 안내로 조용히 꺼지고 나머지 기능은 그대로 동작한다.

1. [developers.naver.com/apps/#/register](https://developers.naver.com/apps/#/register)에서
   앱 등록 (무료). 사용 API로 **검색 > 쇼핑**을 선택
2. 발급받은 Client ID / Client Secret을 Vercel 프로젝트 **Settings → Environment Variables**에
   `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`으로 등록
3. 재배포하면 적용된다

**정확도 주의**: 브랜드+영문 상품명으로 국내 상품을 키워드 검색하는 방식이라 다른 색상·모델이
섞일 수 있다(PRD.md에도 "가장 큰 난제"로 적혀 있던 부분). 그래서 결과는 항상 참고용으로만
표시되고, 링크를 눌러 직접 확인하도록 안내한다.

## 로컬 개발

```bash
npm ci                      # lockfile 그대로 설치
npm test                    # 회귀 테스트 (네트워크 미사용)
npx playwright install chromium   # PC 수집기·브라우저 테스트용
```

`npm test`는 Node 내장 test runner를 쓴다. 브라우저 회귀 테스트(`tests/web.test.js`,
`tests/browser.test.js`)는 실제 Chromium을 띄우되 모든 요청을 fixture로 가로채므로
외부 사이트에 접속하지 않는다. Chromium이 없으면 그 테스트만 건너뛴다.
브라우저 경로를 직접 지정해야 하면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`을 쓴다.

문법만 빠르게 확인하려면:

```bash
node --check api/scan.js
node --check scripts/local-crawler/crawl.js
node --check scripts/feed-import/import-feed.js
```

프론트만 확인하려면 정적 서버로 충분하다 (단, `/api/*` 호출은 실패하고 원가는
"계산 미완료"로 표시된다):

```bash
python3 -m http.server 8000 --directory web
```

`/api/scan`·`/api/config`까지 로컬에서 테스트하려면 [Vercel CLI](https://vercel.com/docs/cli)의
`vercel dev`를 쓴다.

### 원가 계산 엔진

계산 로직은 `web/shared/cost.js` **한 곳**에만 있다. 서버(`api/_lib/landedCost.js`)는
`config/cost.yaml`을 읽어 넣어주는 래퍼이고, 브라우저는 `GET /api/config`로 같은 설정을 받아
같은 함수를 실행한다. 화면 안에 세율·배송 요율표를 다시 두지 않는다.

`core/landed_cost.py`는 참고/검증용 Python 구현이다.

```bash
pip install pyyaml
python core/landed_cost.py
```

## 설정

숫자는 코드에 넣지 않는다. 두 설정 파일만 고치면 된다.

| 파일 | 항목 |
|---|---|
| `config/cost.yaml` | 환율(`fx.base_rate`)·기준일, 카드수수료, 시장별 부가세(`markets`), 배대지 요율, 관세율·면세한도, 판매채널 수수료 |
| `config/targets.json` | 판매처 정본 (sourceId·시장·통화·어댑터·실행 환경·지원 상태). 서버 스캔·PC 수집기·웹이 모두 이 파일을 읽는다 |

`markets`에서 `cost_profile`이 `null`인 시장(예: GB)은 세금·배대지 조건이 검증되지 않았다는
뜻이고, 그 상품은 원문 가격만 표시하고 원가를 계산하지 않는다. 영국을 EU 규칙에 넣지 않는다.

관세 규정은 바뀐다. `cost.yaml`의 `meta.last_verified` 날짜를 보고 분기마다 확인할 것.

## 이번 버전에서 빠진 것 (다음 단계)

- **국가별 라이브 수집 검증** — 판매처는 등록돼 있지만 실제 수집으로 확인된 곳은
  `docs/VERIFICATION.md`에 적힌 것뿐이다. 나머지는 `unverified`다
- **여러 몰 교차 매칭·최저가 자동 선택** (PRD 6장) — 지금은 판매처 하나당 하나의 소스만 본다
- **전일 대비 세일 신호**(세일 개시/추가 세일 감지) — 스캔 결과를 저장하는 DB가 없어서
  "지금 세일 중인 상품" 스냅샷만 제공한다. 저장소(Vercel Postgres/KV 등)를 붙이면 확장 가능
- **국내 시세 매칭 정확도** — 키워드 검색 기반이라 신뢰도가 낮다. SKU/바코드 매칭이 다음 단계
- **상품명 한글 번역** — 영문 원문 그대로 표시. 게시글 작성 시 직접 다듬을 것
- **피드 자동 갱신** — 지금은 파일을 받아 수동 변환한다. 키는 반드시 환경변수로

## 다음 작업

`CLAUDE.md`의 "미완성" 항목을 참고한다.
