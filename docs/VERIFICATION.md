# 검증 기록 — 무엇을 실제로 확인했고 무엇이 미검증인가

- 작성일: 2026-09-08
- 대상: `docs/CRAWLING_REVIEW_AND_IMPROVEMENT_PLAN.md`의 T00~T10
- 실행 환경: Linux(컨테이너), Node v22.22.2, npm 10.9.7, Chromium 1194(이미지 내장)
- **외부 네트워크: 차단됨.** 이 환경의 egress 정책이 www.rei.com·api.frankfurter.dev 등
  외부 호스트로 나가는 CONNECT를 403으로 거부한다(프록시 로그로 확인).

이 문서는 **코드 검증**과 **실제 크롤링 검증**을 구분한다. 계획 6장의 완료 판정 기준에 따라
현재 상태는 **1단계(코드 개선) 완료 / 2단계(요청 범위 완료) 미완료**다.

## 1. 자동 검증 (네트워크 미사용)

```bash
npm ci
npm test
node --check api/scan.js
node --check scripts/local-crawler/crawl.js
node --check scripts/feed-import/import-feed.js
```

결과: **94 pass / 0 fail** (Chromium 경로 지정 시. 브라우저가 없으면 브라우저 테스트 3건 skip)

| 파일 | 다루는 리뷰/검수 항목 |
|---|---|
| `tests/money.test.js` | R05 / Q03 — 통화·숫자 표기 |
| `tests/offers.test.js` | R04, R06 / Q04 — 옵션별 가격·재고 결합 |
| `tests/cost.test.js` | R12 / Q10 — 서버·웹 계산 일치, 무게 구간, GB 미완료 처리 |
| `tests/sources.test.js` | R02, T01 — 판매처 정본, 중복·허용 URL·국가·브랜드 선택 |
| `tests/merge.test.js` | R09, R10 / Q01, Q07, Q08 — 병합·보존·조각 누적 |
| `tests/scan.test.js` | R01~R04 / Q01, Q02 — 조각 스캔, 중복 요청, 상태 분류 |
| `tests/feed.test.js` | R05, R06 / Q03, Q05 — 피드 파싱 |
| `tests/jsonld.test.js` | R08 / Q05 — JSON-LD 구조 |
| `tests/crawler.test.js` | R07, R11 / Q02, Q06 — 발견·404 진행·한도·차단·링크 검증 |
| `tests/browser.test.js` | 실제 Chromium으로 어댑터 글루(지연 렌더링·404·옵션 가격) |
| `tests/web.test.js` | R09, R10, R12 / Q07~Q10, Q12 — 가져오기·보존·XSS·IndexedDB·필터·원가 일치·조각 스캔 |

브라우저 테스트는 Playwright의 요청 가로채기로 fixture만 응답하므로 **외부 사이트에
접속하지 않는다**. 즉 "코드가 그렇게 동작한다"는 증거이지, "그 사이트가 그렇게 응답한다"는
증거가 아니다.

## 2. 리뷰 항목별 처리 상태

| ID | 상태 | 어디서 고쳤나 |
|---|---|---|
| R01 | 수정 | `api/scan.js` 상태 분류(+`crawlers/` 어댑터 분리). 404·410·HTML·타임아웃·403을 구분 |
| R02 | 수정 | `web/shared/sources.js` `selectSources()` — 브랜드 관련 소스만, sourceId 중복 제거 |
| R03 | 수정 | `api/scan.js` — products 배열 없는 JSON은 parse_error, 페이지 한도·캡을 응답에 표시 |
| R04 | 수정 | `web/shared/offers.js` + `api/_lib/shopify.js` — 같은 variant 안에서만 결합 |
| R05 | 수정 | `web/shared/money.js` + 피드/JSON-LD 어댑터 |
| R06 | 수정 | `scripts/feed-import/lib.js` — g:price 단독, 재고 수량, fast-xml-parser |
| R07 | 수정 | `crawlers/generic-jsonld.js` + `scripts/local-crawler/crawl.js` |
| R08 | 수정 | `crawlers/jsonld.js` |
| R09 | 수정 | `web/shared/merge.js` + 웹 가져오기/스캔 경로 |
| R10 | 수정 | `web/index.html` — textContent 렌더링, URL 검증, 원자적 import |
| R11 | 수정 | `crawlers/links.js`, `web/shared/urls.js` |
| R12 | 수정 | `web/shared/brands.js`, `web/shared/cost.js`, `GET /api/config` |

## 3. 검수 시나리오(Q01~Q12) 결과

| ID | 결과 | 근거 |
|---|---|---|
| Q01 | 통과 | `tests/scan.test.js`, `tests/web.test.js`(cursor 끝까지 소비, 중복 요청 0) |
| Q02 | 통과 | `tests/scan.test.js`, `tests/crawler.test.js`(403/404/410/429/timeout/HTML 구분, 404 뒤 정상 수집) |
| Q03 | 통과 | `tests/money.test.js`, `tests/feed.test.js` |
| Q04 | 통과 | `tests/offers.test.js`, `tests/scan.test.js` |
| Q05 | 통과 | `tests/jsonld.test.js`, `tests/feed.test.js` |
| Q06 | 통과 | `tests/crawler.test.js`(상대/절대/프로토콜 상대·외부 도메인·사설 IP) |
| Q07 | 통과 | `tests/merge.test.js`, `tests/web.test.js`(REI Patagonia → Arc'teryx 연속 가져오기) |
| Q08 | 통과 | `tests/merge.test.js`, `tests/web.test.js`(거부·한도·IndexedDB 복원) |
| Q09 | 통과 | `tests/web.test.js`(HTML/javascript: 문자열이 실행되지 않음) |
| Q10 | 통과 | `tests/cost.test.js`, `tests/web.test.js`(서버·화면 원가 일치, GB 계산 미완료) |
| **Q11** | **미실행** | 외부망 차단으로 라이브 수집 불가 (아래 4장) |
| Q12 | 부분 통과 | `tests/web.test.js`에서 가져오기 → 필터 → 상세 → 게시글까지 확인. 실제 스마트폰·배포 환경에서의 흐름은 미확인 |

`--resume` 2회 이상 반복(Q07 일부)은 단위 테스트 수준(누적 로직)까지만 확인했고, 실제 사이트
대상 반복 실행은 Q11과 함께 미실행이다.

## 4. 미검증 — 라이브 수집 (Q11, T05·T06의 실행 부분)

계획이 요구한 "국가별 실제 20건 수집 + 표본 3건 대조"는 **하지 못했다.**
이 세션의 egress 정책이 외부 쇼핑몰 도메인을 차단한다(www.rei.com → 프록시 403).

따라서:

- `config/targets.json`의 모든 신규 판매처는 `support.status: "unverified"`로 두었다.
  **어떤 사이트도 `supported`로 올리지 않았다.**
- REI를 포함해 미국·일본·영국·독일·프랑스·이탈리아·스페인·네덜란드 어느 국가도
  "지원 완료"로 표시하지 않았다.
- 기존 `blocked` 기록(2026-09-03·09-05 배포 스캔 결과)은 그대로 보존했다. 이번에 다시
  확인한 것이 아니다.

### 사용자 PC에서 검증하는 방법

```bash
npm ci && npx playwright install chromium

# REI (필수 검증 대상)
npm run crawl -- --source rei-us --limit 20 --output output/rei-us.json

# 나머지 7개국 후보
npm run crawl -- --countries JP --limit 20 --output output/jp.json
npm run crawl -- --countries GB --limit 20 --output output/gb.json
npm run crawl -- --countries DE,FR,IT,ES,NL --limit 20 --output output/eu.json
```

각 실행 뒤 아래를 기록하면 그대로 검증 근거가 된다.

1. 실행 시각, 코드 SHA(`git rev-parse HEAD`), OS/Node/브라우저 버전
2. `sourceId`, 시장·locale·통화, 실제 목록/상품 URL, 페이지 수
3. 발견/조회/정상/오류 수와 `status`·`complete` (실행 로그의 "판매처별 상태"에 다 나온다)
4. 표본 3건의 가격·통화·옵션을 **같은 시장 화면에서 직접 확인한 값**과 대조
5. 결과 JSON을 앱 설정 탭에서 가져오기까지 성공했는지

확인된 판매처만 `config/targets.json`의 `support`를 다음처럼 올린다.

```json
"support": { "status": "supported", "checkedAt": "2026-09-09", "environment": "Windows 11 / Node 22 / Chromium 131", "note": "20건 수집, 표본 3건 대조 완료" }
```

실패한 곳은 `blocked`(403·캡차) 또는 `unverified`로 남기고, 실패 이유와 확인일을 함께 적는다.
**대체 사이트로 REI의 필수 검증을 대신하지 않는다.**

## 5. 이 작업에서 하지 않은 것

- 유료 수집 서비스 가입, CAPTCHA 해결, TLS 지문 위장, 주거용 프록시, 로그인 세션 수집
- 세율·관세법 변경. `config/cost.yaml`의 값은 기존 그대로이고, 새로 추가한 것은
  "시장 → 원가 프로필" 매핑과 국가별 VAT 표시뿐이다. 영국은 프로필 없음으로 두었다
- 배포·릴리스·PR 생성 (별도 요청이 있을 때 진행)
- Vercel `vercel dev` 실행 확인 (CLI·네트워크 미사용 환경)
