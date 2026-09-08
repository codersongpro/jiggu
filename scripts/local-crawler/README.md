# PC 브라우저 수집기

Shopify `products.json`이 없는 사이트(REI, 편집숍, 일본·유럽 몰 등)를 PC에서 직접 수집하는 도구다.
Vercel 서버리스에서는 브라우저를 띄울 수 없고, 서버 IP로 나가는 요청이 여러 사이트에서 막히기
때문에 분리했다.

## 하는 것 / 안 하는 것

**하는 것**
- 실제 크롬 브라우저로 페이지를 열어 JS 렌더링까지 마친 화면을 읽는다
- 상품 링크·구조화 데이터가 **실제로 나타날 때까지 기다린 뒤** 추출한다(지연 렌더링 대응)
- 상품 페이지의 표준 구조화 데이터(schema.org JSON-LD)에서 옵션별 가격·재고·이름·이미지·SKU를 읽는다
- 요청 간 2~5초 랜덤 대기, 도메인당 순차 처리, 판매처는 기본 동시 2곳 (CLAUDE.md 수집 규칙)
- 목록 진행 위치를 기록해 **이어받기(resume)** 를 지원한다
- 앱과 같은 계산기(`web/shared/cost.js`)로 원가를 계산해 같은 스키마(schemaVersion 2)로 저장한다

**안 하는 것**
- 봇 탐지 회피. TLS 지문 위장(curl_cffi), Stealth 플러그인, 주거용 프록시, 캡차 자동 풀이는 쓰지 않는다
- 403/캡차/429가 뜨는 사이트는 우회하지 않고 그 판매처를 중단하고 상태로 기록한다.
  그런 응답은 자동 수집을 거부한다는 명시적 의사 표시다
- 로그인 세션·쿠키 수집, 자동 구매

## 설치

```bash
npm ci
npx playwright install chromium
```

브라우저 경로를 직접 지정해야 하는 환경이라면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 환경변수를 쓴다.

## 실행

```bash
# 판매처 하나 (REI 20건)
npm run crawl -- --source rei-us --limit 20 --output output/rei-us.json

# 국가 단위 (해당 국가의 PC 수집 대상 판매처 전부)
npm run crawl -- --countries US,JP,GB,DE,FR,IT,ES,NL --limit 100 --output output/scan.json

# 브랜드 지정 (편집숍 안에서 그 브랜드만 남긴다)
npm run crawl -- --source rei-us --brand patagonia --limit 100 --output output/rei-patagonia.json

# 이어받기 (한도·중단으로 끝난 실행을 계속한다)
npm run crawl -- --resume output/scan.json --output output/scan-resumed.json

# 사업자 사입 모드 원가로 계산
npm run crawl -- --source rei-us --business --limit 20 --output output/rei-business.json
```

| 옵션 | 설명 |
|---|---|
| `--source` | 판매처 ID (`config/targets.json`의 `sourceId`). `--countries`와 함께 쓸 수 없다 |
| `--countries` | 시장(국가) 코드 목록. 예: `US,JP,GB` |
| `--brand` | 브랜드 ID/영문/한글/별칭. 원격 검색이 없으면 발견 결과에서 걸러낸다 |
| `--limit` | 판매처당 수집할 **고유 상품 수** (1~1000, 기본 100). 한도로 끝나면 `complete=false` |
| `--resume` | 이전 결과 파일을 이어받는다. 다른 대상 선택 옵션과 함께 쓸 수 없다 |
| `--business` | 사업자 사입 모드로 원가 계산 (기본: 구매대행) |
| `--concurrency` | 동시에 보는 판매처 수 (기본 2) |
| `--output` | 결과 JSON 경로 (기본 `output/local-scan-<타임스탬프>.json`) |
| `--headed` | 브라우저 창을 띄워 동작 확인 |

`--source`, `--countries`, `--resume` 중 하나도 없으면 도움말만 출력하고 실행하지 않는다.

**종료 코드**: `0` 요청 범위 정상 완료 / `2` 일부 성공·한도 중단(이어받기 가능) / `1` 유효 결과 없음·입력 오류

출력 파일은 임시 파일에 쓴 뒤 검증에 통과해야 최종 경로로 바뀐다 — 실패한 실행이 기존 결과 파일을
덮어쓰지 않는다.

## 결과 읽는 법

실행이 끝나면 판매처별 상태가 출력된다.

| 상태 | 뜻 | 다음 행동 |
|---|---|---|
| `ok` + 범위 완료 | 그 범위를 끝까지 수집 | 그대로 가져오기 |
| `partial` | 한도·중단으로 일부만 | `--resume`으로 이어받기 |
| `empty` | 정상 응답인데 상품 0건 | 목록 URL(세일/카테고리)이 맞는지 확인 |
| `render_required` | 페이지는 열렸는데 구조화 데이터가 없음 | 그 사이트는 JSON-LD를 안 쓴다. 어댑터가 필요 |
| `unsupported_endpoint` | 404/410 | 목록 URL이 바뀌었다 |
| `blocked` / `rate_limited` | 403·캡차·429 | 우회하지 않는다. 제휴 피드(`scripts/feed-import`)로 간다 |
| `timeout` / `http_error` | 일시적 오류(2회 재시도 후에도 실패) | 시간을 두고 다시 실행 |

## 앱에 넣기

앱의 **설정 탭 → 수집 결과 가져오기**에서 결과 JSON을 열면 상품 탭 목록에 **합쳐진다**.
다른 판매처·브랜드로 이미 가져온 상품은 지워지지 않고, 같은 범위를 끝까지 다시 수집한
경우에만 그 범위에서 사라진 상품이 정리된다.

## 대상 사이트 추가

판매처 목록은 `config/targets.json` 하나로 통합돼 있다(예전 `sites.json`은 여기로 이관됐다).

```json
{
  "sourceId": "rei-us",
  "shopName": "REI",
  "kind": "multi_brand",
  "marketCountry": "US",
  "locale": "en-US",
  "currency": "USD",
  "region": "US",
  "baseUrl": "https://www.rei.com",
  "domain": "www.rei.com",
  "allowedHosts": ["www.rei.com"],
  "adapter": "rei-us",
  "runtime": "pc",
  "listingUrls": ["https://www.rei.com/c/clothing"],
  "productIdPattern": "^/product/(\\d+)/",
  "productLinkPattern": "^/product/\\d+/",
  "readySelector": "a[href*=\"/product/\"]",
  "category": "apparel",
  "support": { "status": "unverified", "checkedAt": null, "environment": null, "note": "" }
}
```

- `adapter`: `jsonld-browser`(공용) 또는 사이트 전용(`rei-us`). 등록된 이름은 `crawlers/index.js`에 있다
- `productLinkPattern`: 목록에서 상품 상세 링크만 고르는 정규식. **pathname**으로 검사하므로
  상대·절대 URL이 같은 결과를 낸다. 생략하면 `/product/`, `/products/`, `/p/`, `/dp/`, `/item/`, `/shop/`
- `productIdPattern`: 상품 ID를 뽑는 정규식(캡처그룹 1개). 같은 상품의 다른 URL을 하나로 모은다
- `region`: 원가 계산 프로필(US/EU/JP). **모르면 `null`로 둔다** — 그러면 원문 가격만 표시하고
  원가는 "계산 미완료"가 된다. 영국(GB)이 그 예다. EU 규칙을 다른 나라에 복사하지 않는다
- `support.status`: `supported`는 **실제 수집 결과를 확인한 뒤에만** 붙인다. 등록만으로 올리지 않는다

## 정공법: 제휴 상품 피드

봇 차단이 걸린 대형 브랜드(코치·마이클코어스·케이트스페이드·랄프로렌 등)의 가격 데이터는
스크래핑이 아니라 **어필리에이트 네트워크의 공식 상품 피드**로 받는다.
`scripts/feed-import/README.md` 참고.
