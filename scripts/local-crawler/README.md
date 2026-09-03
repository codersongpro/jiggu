# 로컬 브라우저 크롤러

Shopify `products.json`이 없는 사이트(REI, 백화점형 편집숍 등)를 PC에서 직접 수집하는 보조 도구다.
Vercel 서버리스에서는 브라우저를 띄울 수 없어서 분리했다.

## 하는 것 / 안 하는 것

**하는 것**
- 실제 크롬 브라우저로 페이지를 열어 JS 렌더링까지 마친 화면을 읽는다
- 상품 페이지의 표준 구조화 데이터(schema.org JSON-LD)에서 가격·이름·이미지·SKU를 추출한다
  → 사이트마다 다른 CSS 클래스명을 추측할 필요가 없다
- 요청 간 2~5초 랜덤 대기, 도메인당 순차 처리 (CLAUDE.md 수집 규칙)
- `api/_lib/landedCost.js`로 앱과 동일한 원가를 계산해 같은 스키마로 저장한다

**안 하는 것**
- 봇 탐지 회피. TLS 지문 위장(curl_cffi), Stealth 플러그인, 주거용 프록시, 캡차 자동 풀이는 쓰지 않는다.
- 403/503/캡차가 뜨는 사이트는 우회하지 않고 `sites.json`에서 뺀다.
  그런 응답은 그 사이트가 자동 수집을 거부한다는 명시적 의사 표시다.

## 실행

```bash
npm install playwright
npx playwright install chromium

node scripts/local-crawler/crawl.js             # 구매대행 모드(기본)
node scripts/local-crawler/crawl.js --business  # 사업자 사입 모드
```

결과는 `scripts/local-crawler/output/local-scan-<타임스탬프>.json`에 저장된다.

## 앱에 넣기

앱의 **설정 탭 → 로컬 크롤링 결과 가져오기**에서 위 JSON 파일을 열면 상품 탭 목록에 합쳐진다.
같은 사이트를 다시 크롤링해 가져오면 그 사이트 항목만 교체된다.

## 대상 사이트 추가

`sites.json`의 `listingUrls`에 **실제로 브라우저에서 열어본 세일/클리어런스 카테고리 URL**을 넣는다.
지금 들어있는 값은 각 사이트 첫 화면이라 상품이 몇 개 안 잡힌다 — 세일 페이지 URL로 바꿔야 제 역할을 한다.

```json
{
  "brand": "REI",
  "domain": "www.rei.com",
  "listingUrls": ["https://www.rei.com/rei-garage"],
  "linkPattern": "^/product/\\d+/",
  "currency": "USD",
  "region": "US",
  "defaultCategory": "apparel"
}
```

- `linkPattern`: 목록 페이지에서 상품 상세 링크만 골라내는 정규식. 생략하면
  `/product/`, `/products/`, `/p/`, `/dp/`, `/item/`, `/shop/` 중 하나가 들어간 링크를 상품으로 본다.
- 돌려봤는데 0건이 나오면 그 사이트는 JSON-LD를 안 쓰거나 링크 패턴이 다른 것이다.
  실행 로그에 사이트별 링크 개수가 찍히니 그걸 보고 판단한다.

## 정공법: 제휴 상품 피드

봇 차단이 걸린 대형 브랜드(코치·마이클코어스·케이트스페이드·랄프로렌 등)의 가격 데이터는
스크래핑이 아니라 **어필리에이트 네트워크의 공식 상품 피드**로 받는 게 정공법이다.
Rakuten Advertising, CJ Affiliate, Awin, Impact 등에 가입하면 정가·할인가·SKU·재고·이미지가
정리된 CSV/XML 피드를 제공한다. 스크래핑보다 데이터 품질이 좋고 차단 걱정도 없다.
