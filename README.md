# 해외의류 소싱 크롤러 — 핫딜 레이더

가족용 해외 세일 감지 + 원가 계산 + 게시글 생성 도구. Vercel에 배포해 스마트폰에서
스캔 버튼을 누르면 등록된 브랜드몰들을 실시간으로 조회해 세일 상품을 정리해 준다.

## 폴더 구조

```
├── CLAUDE.md               프로젝트 맥락 (Claude Code가 먼저 읽음)
├── PRD.md                  설계 문서
├── config/
│   ├── cost.yaml            관세·환율·배대지·수수료 설정
│   └── targets.json         스캔 대상 브랜드몰 목록 (여기에 사이트 추가/삭제)
├── core/
│   └── landed_cost.py       원가·마진 계산 엔진 (Python, 참고/검증용)
├── api/
│   ├── scan.js               Vercel 서버리스 함수 — 실제 스캔 실행
│   ├── korea-price.js         국내 시세 온디맨드 조회 (네이버쇼핑, 상품 상세를 열 때만)
│   └── _lib/landedCost.js    원가·마진 계산 엔진 (Node 포팅, landed_cost.py와 결과 동일)
├── vercel.json / package.json
└── web/
    └── index.html            모바일 프론트 (정적, Vercel이 그대로 서빙)
```

## Vercel 배포

1. 이 저장소를 GitHub에 올리고 [vercel.com](https://vercel.com)에서 Import
2. 빌드 설정은 건드릴 필요 없음 (`vercel.json`이 정적 파일 위치와 함수 설정을 지정)
3. Deploy 누르면 끝 — 별도 환경변수나 DB 설정 없이 바로 동작한다

배포되면 `/`가 `web/index.html`을, `/api/scan`이 스캔 함수를 서빙한다.

**주의**: 이 프로젝트를 만든 세션은 외부 네트워크가 막혀 있어 `config/targets.json`에
등록한 사이트들이 실제로 응답하는지 직접 확인하지 못했다. **배포 후 반드시 스캔 버튼을
눌러 `errors`에 어떤 사이트가 실패하는지 확인할 것.** 실패한 사이트는 Shopify가 아니거나
안티봇이 걸려 있을 수 있다 — `config/targets.json`에서 지우거나 `verified` 값을 참고해
교체하면 된다.

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
npm install
```

프론트만 확인하려면 정적 서버로 충분하다 (단, 이 경우 `/api/scan` 호출은 실패한다):

```bash
python3 -m http.server 8000 --directory web
```

`/api/scan`까지 로컬에서 테스트하려면 [Vercel CLI](https://vercel.com/docs/cli)로
`vercel dev`를 쓰는 것을 권장한다.

### 원가 계산 엔진 (Python, core/landed_cost.py)

```bash
pip install pyyaml
python core/landed_cost.py
```

미국·유럽·일본 상품의 통관 모드별 원가가 출력된다. `api/_lib/landedCost.js`가 이 로직을
Node로 그대로 옮긴 버전이며, 1원 단위까지 결과가 일치하도록 검증했다.

## 설정

숫자는 코드에 넣지 않는다. 두 설정 파일만 고치면 된다.

| 파일 | 항목 |
|---|---|
| `config/cost.yaml` | 환율(`fx.base_rate`), 카드수수료, 유럽/일본 부가세, 배대지 요율, 관세율·면세한도, 판매채널 수수료 |
| `config/targets.json` | 스캔 대상 브랜드몰 (도메인·지역·통화·카테고리). Shopify `products.json`을 쓰는 사이트만 추가 가능 |

관세 규정은 바뀐다. `cost.yaml`의 `meta.last_verified` 날짜를 보고 분기마다 확인할 것.

## 이번 버전에서 빠진 것 (다음 단계)

- **여러 몰 교차 매칭·최저가 자동 선택** (PRD 6장) — 지금은 사이트 하나당 하나의 소스만 본다
- **전일 대비 세일 신호**(세일 개시/추가 세일 감지) — 스캔 결과를 저장하는 DB가 없어서
  "지금 세일 중인 상품" 스냅샷만 제공한다. 저장소(Vercel Postgres/KV 등)를 붙이면 확장 가능
- **국내 시세 매칭 정확도** — 상품 상세를 열 때만 온디맨드로 조회하고(스캔 전체는 타임아웃상
  불가능), 키워드 검색 기반이라 신뢰도가 낮다. SKU/바코드 매칭으로 정확도를 올리는 건 다음 단계
- **상품명 한글 번역** — 영문 원문 그대로 표시. 게시글 작성 시 직접 다듬을 것
- **안티봇 있는 대형 종합몰**(Shopbop, Nordstrom Rack, Saks OFF 5TH 등) — 브라우저 자동화가
  필요해 Vercel 서버리스 범위 밖. `byungjunjang/web-crawler` 같은 로컬 도구로 별도 수집 후
  업로드하는 구조를 추가하면 확장 가능

## 다음 작업

`CLAUDE.md`의 "미완성" 항목을 참고한다.
