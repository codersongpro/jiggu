# Jiggu 크롤링 코드 리뷰 및 개선 실행 계획

- 작성일: 2026-09-08
- 저장소: [codersongpro/jiggu](https://github.com/codersongpro/jiggu)
- 검토 기준: [4818bda035c471025ef78abb5b1b662348d4830f](https://github.com/codersongpro/jiggu/commit/4818bda035c471025ef78abb5b1b662348d4830f)
- 기준 브랜치: `claude/overseas-shopping-crawler-1doa3l`
- 현재 패키지: `sourcing-crawler@1.0.0`
- 용도: Sol 모델에 코드 수정을 맡길 때 사용하는 작업 명세와 검수 기준
- 문서 상태: 코드 리뷰 및 구현 계획. 아래 수정과 사이트별 크롤링 완료를 주장하는 문서가 아니다.

## 1. 목표와 확정 범위

**Shopify 전용 수집에서 벗어나, 미국·일본·유럽의 공식몰과 편집숍 상품을 같은 형식으로 수집하고 기존 모바일 웹에서 활용한다. REI는 필수 검증 사이트다.**

사용자가 확정한 범위는 다음과 같다.

| 항목 | 결정 |
|---|---|
| 1차 검증 국가 | 미국, 일본, 영국, 독일, 프랑스, 이탈리아, 스페인, 네덜란드 |
| 판매처 | 브랜드 공식몰·공식 아울렛과 여러 브랜드를 판매하는 편집숍 |
| 비용 | 무료 공개 데이터와 PC 보조 수집. 유료 수집 서비스는 필수 의존성에서 제외 |
| 실행 | 기존 Vercel 모바일 웹 유지 + Windows PC의 Node.js/Playwright 수집기 |
| 결과 전달 | PC에서 결과 JSON 생성 → 기존 웹의 파일 가져오기로 반영 |
| 후속 구현 | Sol이 작업 ID별로 수정·검증. 이 문서를 올리는 작업에서는 앱 코드를 변경하지 않음 |

브랜드와 판매처를 구분한다. 예를 들어 REI를 한 번 수집해 Patagonia·Arc'teryx·The North Face 등 여러 브랜드를 얻는 구조다. 브랜드마다 공식몰 전용 수집기를 하나씩 만들 필요는 없다.

“웬만한 브랜드 지원”의 성과는 등록된 이름 수가 아니라 **최근 유효 상품을 확보한 브랜드 수, 국가별 정상 수집처 수, 가격·재고 정확성**으로 측정한다. 1차에는 아래 8개국에서 각각 한 곳 이상을 검증하고, 이후 같은 소스 등록 방식으로 국가와 판매처를 늘린다.

현재 프로젝트는 가족용 소싱·원가 계산·게시글 작성 도구다. 기존 모바일 화면, 구매대행/사업자 사입 모드, 상품·Sale중 탭, 게시글 기능을 유지한다. Streamlit 전환, 자동 구매, 로그인 세션 수집, 클라우드 자동 동기화, 유료 프록시, CAPTCHA 해결, 전면 재작성은 이번 계획에 포함하지 않는다.

## 2. 현재 상태와 코드 리뷰

### 2.1 실제 구현 구조

| 영역 | 확인한 구현 |
|---|---|
| 웹 | `web/index.html`의 정적 HTML/CSS/JavaScript |
| 서버 수집 | `api/scan.js`: 모든 활성 대상에 `/products.json` 요청 |
| 수집 설정 | `config/targets.json`: 공식몰 항목 74개 + 편집숍 항목 8개 = 82개 |
| 설정상 제외 | 35개가 `verified: blocked`; 서버 수집 대상은 47개 |
| Sale중 | `popular: true` 37개 중 blocked를 제외하면 Isabel Marant·Stussy 2개만 대상 |
| PC 수집 | `scripts/local-crawler/crawl.js`와 사이트 설정 15개. 14개는 홈페이지를 시작 URL로 사용 |
| 피드 | `scripts/feed-import/import-feed.js`: CSV/TSV/XML 파일 변환 |
| 원가 | Node, Python, 브라우저에 계산 구현이 나뉘어 있음 |
| 의존성·검증 | 루트 의존성은 js-yaml. npm test/build/typecheck 스크립트와 자동 테스트 파일, CI 워크플로는 검토 트리에 없음 |
| 버전 근거 | package.json, 기본 브랜치 최신 커밋과 전체 파일 목록 확인. GitHub Release는 없음 |

설정의 `confirmed`는 실제 접속 성공 인증이 아니다. 현재 설명에는 Shopify 사용에 대한 확신도와 실행 결과가 혼재한다. 기존 `blocked` 기록도 과거 설정 데이터이며 이번 리뷰에서 모든 사이트의 차단을 재확인한 결과가 아니다.

### 2.2 우선 수정할 문제

P1은 상품 확보·가격 판단·데이터 보존에 직접 영향을 주는 문제, P2는 범위 확대와 운영 신뢰도를 낮추는 문제다. 링크의 줄 번호는 위 기준 커밋에 고정돼 있다.

| ID | 우선순위 | 확인된 문제와 영향 | 근거 |
|---|---|---|---|
| R01 | P1 | 모든 사이트를 Shopify 방식으로 처리한다. 404·410·HTML 응답·타임아웃을 플랫폼 미지원/주소 변경/차단으로 분리하지 않고 blocked로 묶었다. 설정에 브랜드를 추가해도 다른 플랫폼 상품은 확보되지 않는다. | [scan.js:193](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/api/scan.js#L193), [targets.json](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/config/targets.json) |
| R02 | P1 | 브랜드 지정 조회가 관련 공식몰만 선택하지 않고 활성 47곳 전체를 조회한 뒤 편집숍 8곳을 다시 추가한다. 격리 실행에서 55회 요청/47개 고유 URL을 확인했다. | [scan.js:196](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/api/scan.js#L196) |
| R03 | P1 | 올바른 products 배열이 없는 JSON도 성공 0건이 된다. 2페이지의 429는 숨겨지고 성공으로 집계된다. 최대 4페이지/1,000개 제한이 있는데 브랜드 “전체” 조회처럼 안내한다. | [scan.js:126](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/api/scan.js#L126), [README](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/README.md) |
| R04 | P1 | 서로 다른 옵션의 최소 판매가와 최대 정가를 조합한다. 50/100달러 옵션과 80/200달러 옵션으로 실제 없는 75% 할인이 만들어졌다. 가격·SKU·색상·사이즈도 서로 다른 옵션에서 올 수 있다. | [scan.js:77](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/api/scan.js#L77) |
| R05 | P1 | 피드 숫자 파서가 `¥12,800 → 12.8`, `1,299 → 1.299`로 처리한다. `19.99 GBP`는 USD로 바뀔 수 있다. 일본·영국 수집 확대 전에 반드시 수정해야 한다. | [import-feed.js:169](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/feed-import/import-feed.js#L169) |
| R06 | P1 | Google Shopping의 g:price만 있는 정상 상품이 필수 salePrice 검사에서 거부된다. 재고 수량 10도 0 포함 여부 때문에 품절로 처리된다. XML 엔티티도 정상 해석하지 않는다. | [import-feed.js:36](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/feed-import/import-feed.js#L36), [201](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/feed-import/import-feed.js#L201), [276](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/feed-import/import-feed.js#L276) |
| R07 | P1 | PC 수집기는 DOMContentLoaded 직후 추출하며 지연 렌더링·페이지 이동을 처리하지 않는다. 상세 상품 404 하나에 그 뒤 상품까지 수집을 중단한다. | [crawl.js:153](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/local-crawler/crawl.js#L153) |
| R08 | P1 | JSON-LD의 AggregateOffer 최소·최대 가격을 판매가·정가로 오인해 허위 할인을 만든다. 객체형 mainEntity의 Product를 놓치고, 여러 Offer의 가격·통화·재고를 한 묶음으로 보존하지 않는다. | [crawl.js:68](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/local-crawler/crawl.js#L68), [107](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/local-crawler/crawl.js#L107) |
| R09 | P1 | 웹 재조회가 부분 실패여도 기존 상품 배열을 교체해 PC에서 가져온 상품을 지울 수 있다. 파일 가져오기도 sourceShop만 기준으로 교체해 REI의 다른 브랜드 결과까지 삭제한다. | [index.html:1379](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L1379), [1438](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L1438) |
| R10 | P1 | 외부 상품명·상점·URL을 innerHTML에 직접 삽입한다. 가져오기 검증도 부족해 잘못된 region을 반영한 뒤 렌더링이 실패하며 앱 상태가 손상될 수 있다. | [index.html:949](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L949), [1070](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L1070), [1376](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L1376) |
| R11 | P2 | URL의 hostname 대신 문자열 포함 여부를 검사한다. 외부 도메인 URL의 쿼리에 허용 도메인을 넣어도 통과한다. REI의 상대경로 전용 패턴은 같은 상품의 절대 URL을 놓친다. | [crawl.js:51](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/scripts/local-crawler/crawl.js#L51) |
| R12 | P2 | 브랜드 칩과 드롭다운이 충돌하며, 영문 브랜드 목록과 검색 별칭이 다르다. 브라우저 원가 계산도 서버와 달라 6kg 배송비가 지역별로 서로 다른 값이 된다. | [index.html:783](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L783), [889](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L889), [547](https://github.com/codersongpro/jiggu/blob/4818bda035c471025ef78abb5b1b662348d4830f/web/index.html#L547) |

### 2.3 이번 리뷰에서 검증한 것과 남은 것

- GitHub의 실제 파일과 고정 커밋을 확인했다. 오래된 설계 문서의 기능을 구현 완료로 간주하지 않았다.
- 원본 함수의 격리 실행/모의 응답으로 중복 요청, 잘못된 성공 집계, 옵션 할인율, 피드 가격·통화·재고, JSON-LD 일부 구조, 상세 404 중단, 브랜드 파싱, 잘못된 import 상태 문제를 재현했다.
- 외부 소스를 읽는 한 shell 네트워크 요청은 실패했다. 네트워크 성공을 가정하지 않고 GitHub에서 읽은 소스와 모의 입력을 사용했다.
- 웹 조회에서 REI 의류 목록과 상품 상세 2개가 읽혔다. 이것은 사용자 PC의 Playwright 수집 성공이나 Vercel 서버 IP의 접근 성공 증거가 아니다.
- 실제 전체 크롤링, 운영 /api/scan 호출, 브라우저 공격 문자열 실행, 사이트별 한국 배송 가능 여부, 세율의 법적 정확성은 검증하지 않았다.
- 이 문서 작성 과정에서 앱 코드 변경·전체 테스트 통과·배포 완료를 주장하지 않는다.

## 3. 수집 구조와 데이터 계약

### 3.1 실행 흐름

```text
공통 판매처 목록
  ├─ Vercel: 지원이 확인된 가벼운 공개 데이터만 작은 단위로 조회
  └─ PC: 상품 URL 발견 → 공개 데이터 추출 → 필요 시 Playwright 렌더링
                       ↓
           같은 옵션의 가격·통화·재고 정규화
                       ↓
       상품 + 판매처별 수집 범위/완료 상태/진단 JSON
                       ↓
       웹에서 검증 후 병합 → 브랜드·국가·판매처별 조회
```

기존 Node.js와 Playwright를 활용한다. 크롤러 전체를 Python/Scrapling으로 다시 작성하거나 프론트 프레임워크를 교체하지 않는다.

### 3.2 판매처 등록과 수집 어댑터

- `config/targets.json`을 판매처 목록의 정본으로 확장한다. 기존 PC의 `sites.json` 항목은 이곳으로 이관하고 CLI·API가 같은 목록을 읽는다. 기존 82개와 PC 15개를 단순 합산하지 말고 동일 판매처/시장 중복을 정리한다.
- 판매처에는 안정적인 `sourceId`, 판매처명, `marketCountry`, `locale`, base URL, 허용 hostname, 수집 adapter, 검증한 목록/사이트맵 URL, 검증일, 실행 환경, 지원 상태를 둔다.
- 브랜드는 별도의 canonical ID·영문명·한글명·별칭으로 관리한다. 판매처 이름을 브랜드 ID로 사용하지 않는다. 편집숍의 실제 수집 상품에서 브랜드 범위를 갱신한다.
- 국가, 통화, 출고국, 브랜드 국적, 상품 원산지를 동일시하지 않는다. 영국의 국가는 GB이고 통화는 GBP다. 국가 코드가 EU이거나 통화가 EUR이라는 이유만으로 세금·배송 조건을 확정하지 않는다.
- 어댑터의 최소 역할은 `discoverProducts({cursor, limit, brandId})`와 `fetchOffers(productUrl)`로 구분한다. 전자는 상품 URL·다음 위치·발견 완료 여부, 후자는 같은 상품의 옵션별 Offer와 추출 경고를 반환한다.
- 수집 방법은 소스별로 확인한 공개 API/피드 → HTML의 구조화 데이터 → 일반 브라우저 렌더링 후 구조화 데이터·검증된 DOM 순서다. 이미 데이터가 충분하면 다음 방법을 실행하지 않는다.
- Shopify `/products.json`은 응답이 검증된 소스에서 유지한다. 전 사이트 공통 계약으로 쓰지 않는다. 상품별 Ajax `.js`를 사용할 때는 locale·표시 통화·금액 단위가 기존 `.json`과 다른 점을 어댑터에서 처리한다. [Shopify Product API](https://shopify.dev/docs/api/ajax/reference/product)
- JSON-LD는 객체·배열·@graph·mainEntity·ProductGroup/hasVariant와 복수 Offer를 처리한다. 출처가 다른 가격을 결합하지 않는다. [Google 상품 옵션 문서](https://developers.google.com/search/docs/appearance/structured-data/product-variants)

### 3.3 상품과 가져오기 형식

기존 필드는 호환하되 새 형식에 다음 정보를 추가한다.

| 대상 | 최소 변경 |
|---|---|
| 상품 | sourceId, marketCountry, brandId, 원문 브랜드/상품명, canonical 상품 URL, product/variant 식별자, currency, price, compareAtPrice, 원문 size/color, availability, collectedAt, warnings |
| 가격 | 가격·통화·정가·사이즈·색상·재고·SKU는 동일 Offer/variant 기준. 옵션별 가격이 다르면 상세에서 선택할 수 있고 카드에는 “~부터” 표시 |
| 할인 | 같은 옵션의 유효 정가가 판매가보다 높을 때만 계산. AggregateOffer의 lowPrice/highPrice는 범위이며 할인 근거가 아님 |
| 수집 결과 | schemaVersion: 2, runId, collectedAt, sourceResults, items |
| 판매처별 결과 | sourceId, 실제 scope(목록/카테고리/브랜드), status, complete, nextCursor, 발견/조회/정상/제외 건수, 오류 분류 |
| 원가 | FX 출처·기준일과 계산 프로필을 보존. 조건을 모르면 원문 가격은 표시하고 총원가는 “계산 미완료” |

가격은 통화가 확인된 원 단위 값으로 저장한다. `¥12,800`, `1,299.00 USD`, `1.299,00 EUR`는 각각 12800, 1299, 1299로 읽는다. source/feed의 숫자 형식을 사용하며 모호한 값은 추측하지 않고 검증 오류로 남긴다. 명시된 GBP를 USD로 바꾸지 않는다.

카드의 최저가와 “~부터”는 재고가 확인된 옵션만 대상으로 한다. 모두 품절이면 품절로 표시하고, 재고가 확인되지 않은 옵션은 “재고 미확인”으로 구분한다. 미확인 재고를 구매 가능한 최저가로 섞지 않는다.

USD·JPY·EUR·GBP를 1차 지원한다. 그 밖의 통화도 원문과 ISO 코드는 보존하되 환율/원가 프로필이 없으면 계산하지 않는다. GBP를 기존 EU 계산에 몰래 넣지 않는다. 영국 및 신규 판매처의 세금·배대지·직배송 조건이 검증되지 않으면 원화 상품가까지만 계산한다.

### 3.4 병합과 데이터 보존

- 상품 키는 `sourceId + canonical 상품 식별자 + variant 식별자`로 구성한다. 브랜드+상품명이나 sourceShop만으로 삭제·합치지 않는다.
- 입력 전체를 먼저 파싱·검증해 임시 상태를 만들고 성공한 뒤 한 번에 반영한다. 잘못된 파일은 기존 상태를 바꾸지 않는다.
- 가져오기 한도는 파일 20MiB, 정규화된 Offer 50,000개로 설정 상수에 둔다. 초과 파일은 반영 전에 거부하고 작은 수집 파일로 나누는 안내를 표시한다.
- 부분 성공·중단·건수 제한·범위 불명 파일은 upsert만 한다. `complete: true`인 정확히 같은 수집 범위가 확인된 경우에만 그 범위의 누락 항목을 갱신/제거한다.
- 404·품절처럼 개별 상품의 상태가 확인되면 해당 상품을 상태 갱신한다. 네트워크 오류나 파싱 실패로 상품을 삭제하지 않는다.
- 기존 schemaVersion 없는 JSON은 호환 입력으로 받아 검증 후 upsert한다. 수집 범위를 알 수 없으므로 범위 삭제는 금지한다.
- 웹 스캔과 PC import 모두 같은 병합 함수를 사용한다. 별도 sourceId의 결과를 덮어쓰지 않는다.
- 가져온 상품과 마지막 정상 결과는 브라우저 IndexedDB에 저장한다. 새로고침 후 복원하고 저장 실패 시 기존 저장본을 유지한다. 클라우드 저장·기기간 자동 공유는 추가하지 않는다.
- 가격·재고의 수집 시각을 표시하고 24시간을 넘으면 오래된 정보로 표시한다. 오래된 기록을 현재 가격이라고 안내하지 않는다.

### 3.5 실패 처리와 실행 한도

- 상태는 `ok`, `partial`, `empty`, `unsupported_endpoint`, `render_required`, `parse_error`, `timeout`, `rate_limited`, `blocked`, `robots_disallowed`, `unverified`를 구분한다. HTTP 상태와 오류 단계도 함께 남긴다.
- HTTP 200의 HTML/challenge나 잘못된 JSON을 정상 0건으로 처리하지 않는다. 첫 페이지/후속 페이지 실패를 모두 진단에 남긴다.
- PC 기본 동시 판매처 2곳, hostname당 문서/API 요청 동시 1개, 요청 간격 2~5초. 일시적 네트워크 오류/5xx만 최대 2회 재시도한다. 429는 해당 실행의 그 판매처를 중단하고 Retry-After를 기록한다.
- 상품 404는 다음 상품으로 진행한다. CAPTCHA·명시적 차단·robots 제한은 중단한다. 단일 상품 404를 사이트 전체 차단으로 바꾸지 않는다.
- 기본 PC 실행은 판매처당 상품 100개까지, 옵션으로 최대 1,000개까지. 1차 검증은 20개로 제한한다. 한도 도달 시 partial과 다음 cursor를 저장하고 이어받기를 지원한다.
- 웹 /api/scan에는 sourceId와 cursor 기반의 작은 조회 단위를 추가한다. 호출당 한 판매처의 한 목록 페이지, 기존 8초 fetch timeout을 유지하고 전체 처리 예산 45초 이내에서 종료한다. DOM 브라우저는 서버 함수에 넣지 않는다.
- 기존 brand/mode/onlyPopular 파라미터 이름과 items/errors/fxRates 등 응답 필드는 유지한다. sourceId가 없으면 그 조건에 맞는 판매처 계획의 첫 페이지를 처리하고 nextCursor를 반환한다. 이후 호출은 같은 조건과 cursor로 다음 페이지/판매처를 이어간다. sourceId가 있으면 그 판매처 안에서만 진행한다. 1회 호출로 여러 판매처 전량을 반환하는 의미는 폐지하며 README와 웹 호출 코드를 함께 변경한다.
- 페이지 응답에는 chunk=true, nextCursor, sourceResults, plannedSources를 추가한다. sitesTotal/sitesOk/sitesFailed는 이번 응답에서 처리한 소스 수이며, 전체 진행률은 웹이 sourceId로 누적한다. 페이지 조각을 완전 스냅샷으로 import하지 않는다. 웹은 runId와 source/scope별로 시작부터 끝까지 누적한 뒤 오류·한도 중단 없는 범위만 complete=true로 확정한다. 중간에 실패하면 누적분은 partial upsert만 한다.
- 웹은 조회 작업을 최대 2개씩 실행한다. 서버에는 동일 인스턴스의 중복 요청 결합과 단기 캐시를 넣되 전역 동시성 보장이라고 설명하지 않는다. 장시간 전체 수집은 PC가 담당한다.
- API 입력은 등록된 sourceId와 검증한 cursor만 받는다. 임의 URL 프록시는 만들지 않는다. PC도 URL 생성·리디렉션에서 허용 hostname과 경로, public HTTP(S) 여부를 검사한다.
- 외부 텍스트는 textContent로 렌더링하고 상품/이미지 링크는 URL 검증 후 DOM 속성에 지정한다. 원문 스크립트·이벤트 속성을 실행하지 않는다.

## 4. 국가별 수집 대상과 REI 구현 기준

### 4.1 1차 후보

아래는 **검증할 판매처**이며, 등록만으로 수집 지원 완료를 표시하지 않는다. 국가란 우선 해당 쇼핑 시장/스토어 설정을 뜻하며 출고국·한국 배송 가능 여부는 별도로 확인한다. 통화는 실제 선택한 스토어 응답과 대조한다.

| 국가 | 우선 후보 | 1차 예상 통화 | 검증 방향 |
|---|---|---|---|
| 미국 | [REI](https://www.rei.com/c/clothing) | USD | 필수. 공개 카테고리·상품 상세·여러 브랜드·옵션 가격 검증 |
| 일본 | [BEAMS](https://www.beams.co.jp/) | JPY | 일본 스토어의 실제 상품 목록, 엔화 숫자·일문 브랜드/사이즈 |
| 영국 | [END. GB](https://www.endclothing.com/gb) | GBP | GB locale 유지, GBP 응답, 옵션·품절 상태 |
| 독일 | [Bergfreunde](https://www.bergfreunde.de/) | EUR | 독일 스토어의 카테고리/상품 상세와 소수점 표기 |
| 프랑스 | [Citadium FR](https://www.citadium.com/fr/fr) | EUR | 프랑스 목록과 브랜드별 상품, 동적 렌더링 여부 |
| 이탈리아 | [LuisaViaRoma](https://www.luisaviaroma.com/en) | EUR | 이탈리아 시장 선택·리디렉션 후 표시 통화 확인 |
| 스페인 | [Tradeinn Dressinn](https://www.tradeinn.com/dressinn/en) | EUR | 스페인 시장 설정·상품 옵션·가격과 재고 |
| 네덜란드 | [Zalando NL](https://www.zalando.nl/) | EUR | NL 스토어 목록과 상품 데이터; 접근 제한 여부 별도 검증 |

웹 조회에서 위 공식 페이지들을 읽었으나 일부 자료는 검색 도구의 캐시일 수 있다. 소스 등록 시 실제 PC 환경에서 다시 검증한다. 실패한 후보를 supported로 바꾸지 않는다. 다른 무료 후보로 확대가 필요하면 같은 국가의 대체 소스를 별도 검증 기록과 함께 추가하되, REI 자체의 필수 완료 조건은 대체 사이트로 충족했다고 처리하지 않는다.

피드·사이트맵·일반 브라우저에서도 자료를 확보하지 못한 국가는 미완료로 남긴다. 국가별 성공 조건을 낮추거나 테스트 데이터를 실제 상품으로 섞어서 완료하지 않는다.

### 4.2 REI의 구체적 수정

현재 설정의 시작 URL은 `https://www.rei.com/rei-garage`이고 상대경로 정규식은 `^/product/\d+/`이다. 우선 `https://www.rei.com/c/clothing`을 검증용 seed로 추가하고, 공개 목록에서 관찰한 다음 페이지 또는 사이트맵으로 상품 URL을 발견한다.

- REI robots.txt는 sitemap.xml을 안내하고 /search 및 일부 필터 쿼리를 제한한다. 제한된 검색 경로에 의존하지 않고 허용된 카테고리·사이트맵·상품 페이지를 사용한다. robots 허용만으로 이용조건 전체의 허가를 단정하지 않는다. [REI robots.txt](https://www.rei.com/robots.txt)
- 링크는 `new URL(href, page.url())`로 해석한 뒤 hostname과 pathname을 검사한다. 상대/절대 URL을 같은 상품 ID로 정규화한다.
- DOMContentLoaded만 기다리지 말고 상품 링크 또는 상품 구조화 데이터가 나타나는 명확한 조건을 기다린다. 다음 페이지/더 보기의 실제 동작을 확인해 cursor를 기록한다.
- JSON-LD로 부족한 필드는 공개 페이지에서 확인한 DOM만 보완한다. 이름·브랜드·가격·통화·상품 URL은 필수이며 선택하지 않은 옵션의 재고/가격을 임의로 채우지 않는다.
- 현재 웹에서 읽힌 [Sahara Shade Hoodie](https://www.rei.com/product/184879/rei-co-op-sahara-shade-hoodie-womens), [Trailmade Pull-On Pants](https://www.rei.com/product/235803/rei-co-op-trailmade-pull-on-pants-womens)는 초기 수동 대조용 후보로만 사용한다. 가격은 실행 시점 페이지를 기준으로 확인한다.
- 검수는 실제 20개 상품 수집, 서로 다른 브랜드 2개 이상, 목록 진행/중복 제거, 상품 표본 3개의 가격·통화·옵션 대조, 생성 JSON의 웹 가져오기까지 수행한다.

### 4.3 제휴 피드의 위치

현재 피드 변환기를 고쳐 선택 경로로 유지한다. Awin·CJ·Impact 가입만으로 원하는 모든 브랜드의 피드가 제공된다고 가정하지 않는다. Awin은 계정이 접근 가능한 피드, CJ는 가입 및 광고주 설정에 따른 export 권한, Impact는 계정에 제공된 카탈로그 범위가 적용된다. 승인된 피드를 사용자가 확보한 경우에만 연결하고 키가 들어간 다운로드 URL을 로그에 남기지 않는다. [Awin 안내](https://help.awin.com/developers/docs/product-feed-publisher-guide-intro), [CJ Product Feeds](https://developers.cj.com/docs/data-imports/product-feeds), [Impact Catalog API](https://integrations.impact.com/impact-publisher/reference/search-catalog-items)

## 5. Sol 작업 목록

순서는 **T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → T10**이다. 각 작업은 범위에 적힌 오류/행동만 수정하고 관련 없는 UI 재설계와 리팩터링은 하지 않는다.

| 작업 | 수정 범위·대상 파일 | 구현 내용 | 검증·완료 기준 |
|---|---|---|---|
| T00 기준선 | package.json, tests/ 신규 | 작업 시작 HEAD와 문서를 비교. Node 내장 test runner에 npm test를 연결하고 확인된 오류의 회귀 fixture를 추가. Playwright는 PC용 개발 의존성으로 lockfile에 기록 | 기존 코드에서 재현되는 실패와 현재 정상 동작을 구분. npm ci가 lockfile 그대로 설치 |
| T01 소스·형식 | config/targets.json, scripts/local-crawler/sites.json, web/shared/ 수집 데이터 모듈 신규 | 판매처 정본 통합, schemaVersion 2, sourceId/brandId, 국가/통화/수집 범위·상태 계약 구현. 서버·PC·웹이 같은 검증/정규화 함수 사용 | 중복 source 검사, 허용 URL 검사, 구형 파일 호환, 미지원 국가/통화의 안전한 처리 |
| T02 가격·Offer | api/scan.js, scripts/feed-import/import-feed.js, scripts/local-crawler/crawl.js | 공통 정규화 사용. 일본·유럽 숫자/GBP, 동일 variant 가격·정가·재고, JSON-LD 구조, g:price 단독·재고 수량·XML 엔티티 오류 수정 | R04~R08 fixture 통과. 실제 없는 할인과 알 수 없는 통화의 USD 대체가 0건 |
| T03 기존 서버 스캔 | api/scan.js, web/index.html의 스캔 호출 | sourceId 중복 제거, 브랜드 관련 공식몰+편집숍 후보만 선택, 상태·cursor·페이지 한도 표시, source/page 단위 조회. Sale중은 수집된 인기 브랜드 기준으로 편집숍 결과도 반영 | 편집숍 1회 조회, 잘못된 JSON은 parse_error, page2 429는 partial/rate_limited, 모든 0건을 성공으로 표시하지 않음 |
| T04 PC 발견·실행 | scripts/local-crawler/crawl.js, crawlers/ 어댑터 신규 | 공통 runner와 소스별 어댑터 분리. readiness·사이트맵/목록 진행·상품 dedupe·전체 한도·resume·상태별 재시도 구현 | 지연 DOM과 2페이지 fixture에서 상품 발견. [404, 정상]에서 정상 상품 확보. 요청 간격·한도·resume 검증 |
| T05 REI | crawlers/ REI 어댑터, config/targets.json, tests/fixtures/ | 4.2의 REI 탐색·상세·옵션 수집을 구현하고 실제 공개 페이지로 검증 | REI 20개·2개 이상 브랜드·표본 3개 대조·JSON import까지 성공. 실패 환경은 기록하고 미완료 표시 |
| T06 7개국 확대 | crawlers/ 소스별 어댑터, config/targets.json, tests/fixtures/ | JP → GB → DE → FR → IT → ES → NL 순서로 후보를 한 곳씩 구현/검증. 기존 소스도 재사용 가능한 부분만 공통화 | 국가별 적어도 1곳, 상품 20개, 표본 3개 대조. 실제 실행 근거 없는 confirmed 금지 |
| T07 웹 보존·안전 | web/index.html, web/shared/ 병합/저장 모듈 | schema 검증 후 원자적 import, 범위별 병합, 실패 데이터 보존, IndexedDB 복원, 외부 텍스트/URL 안전 렌더링 | REI 서로 다른 브랜드 파일 연속 import 유지, 중복 없음, 재조회 실패에도 데이터 유지, 악성 문자열 실행 없음 |
| T08 검색·원가 일치 | web/index.html, api/_lib/landedCost.js, config/cost.yaml, web/shared/ 계산 모듈 | 브랜드 별칭 정본으로 칩/드롭다운/검색 동기화. marketCountry·sourceId 필터를 추가하고 브랜드와 AND 조합. 서버·웹의 순수 계산기를 공용화하고 공개 계산 설정을 같은 원본에서 공급. GBP와 국가별 계산 미완료 처리 | Stance/스탠스 동일 결과. 국가·판매처·브랜드 조합과 초기화 정상. 6kg·구간 경계·10kg 초과·proxy/business 서버/웹 일치 |
| T09 운영 명령·문서 | package.json, scripts/local-crawler/README.md, scripts/feed-import/README.md, README.md | 아래 CLI 계약, 설치·실행·가져오기·진단 설명, 소스별 지원 현황 갱신. 사이트마다 실제 검증일·환경·목록 URL·실패 이유 기록 | Windows의 새 설치에서 REI 명령 실행 후 파일 가져오기 가능. 문서 명령과 실제 CLI 도움말 일치 |
| T10 통합 검수 | tests/, 검증 결과 문서 | 아래 Q01~Q12 수행. 코드/설정/실제 수집 증거를 구분해 완료 보고 | 미통과 항목은 미완료로 표시. 커밋 범위와 검사 결과 제시. 배포·릴리스는 별도 요청이 있을 때 진행 |

T01의 공용 모듈은 정적 웹에서 script로 읽고 Node에서 require할 수 있는 작은 순수 JavaScript 모듈로 만든다. 기존 API의 파일/YAML 로더는 서버 전용 wrapper로 유지한다. 웹에는 비밀 없는 가격 계산 설정만 제공하는 `GET /api/config`를 추가하고, 공급된 설정·환율의 기준일을 보관한다. UI 안에 별도의 세율·배송표를 다시 하드코딩하지 않는다.

T02에서 정규식 XML 파서를 교체할 때는 `fast-xml-parser`를 피드 CLI에 사용한다. 설치 시 현재 지원 버전과 보안 공지를 확인하고 lockfile에 고정한다. 그 외 크롤링 프레임워크·DB·프론트 프레임워크는 추가하지 않는다. 기존 CSV 따옴표/줄바꿈 처리는 회귀 테스트로 유지한다.

세율/관세법을 임의로 바꾸는 작업은 포함하지 않는다. 현행 법령에 대한 검증 없이 기존 EU 규칙을 다른 나라로 복사하거나 계산 결과를 확정 결제금액처럼 표시하지 않는다.

### 구현할 CLI 계약

아래 명령은 **구현 후 제공할 인터페이스**다. 현재 코드에서 아직 지원하지 않는 옵션이 포함되어 있다.

```bash
npm ci
npx playwright install chromium

npm run crawl -- --source rei-us --limit 20 --output output/rei-us.json
npm run crawl -- --countries US,JP,GB,DE,FR,IT,ES,NL --limit 100 --output output/scan.json
npm run crawl -- --source rei-us --brand patagonia --limit 100 --output output/rei-patagonia.json
npm run crawl -- --resume output/scan.json --output output/scan-resumed.json
npm run crawl -- --source rei-us --business --limit 20 --output output/rei-business.json
```

- 기본은 기존 proxy 모드, `--business`는 기존 사업자 사입 모드를 유지한다.
- `--source`와 `--countries`는 대상 선택 방식으로 서로 배타적이며, 모두 없으면 도움말을 출력하고 실행하지 않는다.
- `--brand`는 canonical brand ID/별칭을 정규화하고, 원격 검색이 지원되지 않으면 발견 결과에서 필터링한다. 원하는 브랜드가 0건이면 차단/파싱 실패/정상 0건을 구분한다.
- `--limit`는 1~1,000 범위의 정수이며 source당 고유 상품 수 기준이다. 한도 때문에 끝났다면 complete=false다.
- `--resume`는 이전 결과의 설정·대상·cursor와 기존 items/sourceResults를 함께 읽고 새 결과를 키 기준으로 누적한다. 다른 대상 선택 옵션과 혼용하지 않는다. 재실행의 limit는 source별 이번 실행에서 추가로 수집할 고유 상품 수이며, 생략하면 최초 실행의 limit를 사용한다. 원래 범위의 처음부터 끝까지 누적된 경우에만 complete=true로 출력한다. 마지막 페이지 상품만 들어 있는 파일을 완료 파일로 만들지 않는다.
- 출력은 임시 파일을 검증한 뒤 최종 파일로 교체한다. 실패한 실행으로 기존 성공 파일을 덮어쓰지 않는다.
- 종료 코드는 모든 요청 범위 정상 완료 0, 일부 성공/한도 중단 2, 유효 결과 없는 실패 또는 입력 오류 1로 제공한다. 정상 완료된 빈 범위는 별도 empty 상태다.

## 6. 검수 시나리오와 완료 기준

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| Q01 | 브랜드 지정 스캔과 기존 파라미터 호출 | 관련 소스만 선택하고 동일 source/page는 1회 요청. brand/mode/onlyPopular 조건을 유지한 채 nextCursor를 끝까지 소비하면 전체 누적 결과가 같음. 페이지 조각으로 기존 범위 삭제 금지 |
| Q02 | 잘못된 JSON, 200 challenge, 첫 페이지/후속 페이지 429, timeout, 상품 404 | 서로 다른 진단. partial 표시. 기존 성공 데이터 보존. 404 뒤 정상 상품 수집 |
| Q03 | JPY 12,800 / USD 1,299.00 / EUR 1.299,00 / GBP 19.99 | 금액·통화 정확, GBP의 USD 대체 없음. 모호한 값은 오류·원문 보존 |
| Q04 | 50/100 옵션과 80/200 옵션, AggregateOffer 80~120, 품절 최저가 | 75%/33% 허위 할인 없음. 같은 옵션의 가격/재고/사이즈만 결합 |
| Q05 | mainEntity 객체, @graph, ProductGroup, 동적 JSON-LD, g:price 단독 XML, 재고 10·0 | 정상 구조 추출·가격 fallback·정확한 재고·엔티티 해석 |
| Q06 | 상대/절대/프로토콜 상대 링크, 외부 도메인이 허용 이름을 쿼리에 포함, 외부 redirect | 정상 URL 동일 상품으로 dedupe. 외부/비공개 호스트 접근 거부 |
| Q07 | 동일 JSON 2회, REI Patagonia 후 REI Arc'teryx, 부분 스캔/전체 실패, 구형 파일, 2회 이상 resume | 중복·범위 밖 삭제 없음. resume 완료 파일에 최초 페이지부터 모든 상품이 누적됨. 완전 수집 범위의 정상 0건만 해당 범위 갱신 |
| Q08 | 잘못된 region·가격·URL·대용량 입력·저장 오류 | import 반영 전 거부/제한하고 기존 앱 상태 유지. 새로고침 후 정상 데이터 복원 |
| Q09 | 상품명 HTML, 이벤트 포함 이미지 문자열, javascript: 링크 | 텍스트로 표시하거나 URL 거부. 코드 실행 없음 |
| Q10 | 브랜드 칩/드롭다운, 영문/한글 검색, GBP, 모드/환율 변경, 배송 구간 | 필터 일관성, 계산 미완료 표시, 서버·브라우저 계산 일치 |
| Q11 | REI 및 나머지 7개국 라이브 수집 | 국가별 정상 소스 1개 이상·소스당 20개 상품. 표본 3개를 같은 시장/옵션 화면과 대조. 최소 한 번 목록 진행 확인 |
| Q12 | 모바일 전체 흐름 | PC JSON → 가져오기 → 국가/판매처/브랜드 검색 → 상품 상세 → 게시글 작성. Sale중/상품 탭 상태 분리와 기존 기능 유지 |

자동 검증은 네트워크 없는 fixture와 Node 내장 test runner 중심으로 만든다. 브라우저 입력/표시/IndexedDB 회귀는 Playwright로 확인한다. 사이트 전체 HTML, 사용자 쿠키, 계정 정보는 fixture에 넣지 말고 상품 정보와 구조 검증에 필요한 최소 예제로 제한한다.

```bash
npm ci
npm test
node --check api/scan.js
node --check scripts/local-crawler/crawl.js
node --check scripts/feed-import/import-feed.js
```

기존 프로젝트에는 별도 컴파일 빌드나 타입체크가 없다. 존재하지 않는 명령을 실행했다고 보고하지 않는다. 추가한 모든 JavaScript 파일과 HTML 인라인 스크립트의 문법, Vercel dev에서 API/정적 경로 동작, PC Playwright 실행을 별도로 확인한다.

라이브 검증 기록에는 실행 시각, 코드 SHA, OS/Node/브라우저 버전, sourceId, 시장·locale·통화, 실제 목록/상품 URL, 페이지 수, 발견/정상/오류 수, complete/partial, 표본 대조 결과를 남긴다. 상품 재고·세일 변화에 따라 숫자는 달라질 수 있지만 가격·통화·옵션이 서로 맞아야 한다.

**완료 판정은 두 단계로 구분한다.**

1. 코드 개선 완료: T00~T04, T07~T09와 자동/브라우저 회귀 검증 통과.
2. 요청 범위 완료: REI 필수 검증과 미국·일본·유럽 6개국 각각의 실수집·가져오기 검증까지 통과.

접근 제한 때문에 어떤 국가/판매처가 검증되지 않으면 1단계만 완료했다고 보고한다. HTTP 조회·모의 테스트 성공을 실제 지원 완료로 대신하지 않는다.

## 7. Sol에 전달할 실행 지시문

다음 내용을 이 문서와 함께 전달한다.

> codersongpro/jiggu의 docs/CRAWLING_REVIEW_AND_IMPROVEMENT_PLAN.md를 기준으로 T00부터 순서대로 구현한다. 먼저 현재 HEAD와 검토 기준 4818bda의 차이를 확인하고, 이미 수정된 문제는 재현 여부를 재확인해 중복 수정하지 않는다.
>
> 목표는 기존 Vercel 모바일 화면을 유지하면서 무료 PC 수집 결과를 JSON으로 가져오고, REI를 포함한 미국·일본·영국·독일·프랑스·이탈리아·스페인·네덜란드에서 상품을 확보하는 것이다. 공식몰과 편집숍을 모두 지원하되 판매처와 실제 브랜드를 구분한다.
>
> 한 번에 작업 ID 하나를 완료한다. 변경 파일, 해결한 리뷰 ID, 실행한 검증 명령과 결과, 다음 작업을 짧게 보고한다. 실패한 검증은 원인을 고친 뒤 재실행한다. 처음부터 전체 UI·기술 스택을 다시 만들지 않는다.
>
> prices/variants/통화, source 상태와 수집 범위, 부분 실패 시 데이터 보존을 먼저 고친다. 국가별 소스는 실제 상품 URL과 가격 대조 근거가 있어야 지원 완료로 표시한다. REI는 다른 사이트로 대체해 완료 처리하지 않는다.
>
> 세금·배송 조건이 불명확하면 원문 가격을 보존하고 원가를 계산 미완료로 표시한다. 미지원 통화를 USD로 바꾸거나 영국을 EU 규칙에 넣지 않는다.
>
> 유료 서비스 가입·결제, CAPTCHA 해결, 쿠키/로그인 세션 수집, 자동 구매, 클라우드 동기화는 추가하지 않는다. 비밀정보는 코드·브라우저·로그에 남기지 않는다.
>
> 검증을 마친 요청 범위 변경은 커밋·푸시하되 PR 생성, 버전 올리기, 릴리스, 배포는 별도 요청이 있을 때 진행한다. 최종 보고에서 코드 검증과 실제 크롤링 검증을 구분하고, 국가별 미완료 항목을 숨기지 않는다.
