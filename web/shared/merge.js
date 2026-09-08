/* 수집 결과 병합 — 브라우저/Node 공용
 *
 * 예전 웹은 재조회가 부분 실패해도 상품 배열을 통째로 교체했고, 파일 가져오기는
 * sourceShop만 보고 지웠다(리뷰 R09). REI에서 Patagonia를 가져온 뒤 Arc'teryx를
 * 가져오면 앞의 결과가 사라졌다.
 *
 * 규칙
 *  - 기본은 upsert. 키(sourceId::상품::variant)가 같으면 갱신, 없으면 추가.
 *  - 삭제는 "완전히 같은 수집 범위를 끝까지 봤다(complete)"고 확인된 경우에만,
 *    그 범위 안에서만 한다.
 *  - 네트워크 오류·파싱 실패로는 절대 지우지 않는다. 개별 상품 404/품절만 상태를 바꾼다.
 */
(function (root, factory) {
  const mod = factory(typeof require === "function" ? require("./schema.js") : root.JigguSchema);
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.JigguMerge = mod;
})(typeof self !== "undefined" ? self : this, function (schema) {
  "use strict";

  function emptyState() {
    return { items: [], sourceResults: [], updatedAt: null };
  }

  /**
   * @param {{items:Array, sourceResults:Array}} state 기존 상태 (변경하지 않는다)
   * @param {{items:Array, sourceResults:Array, collectedAt:string}} incoming 검증을 통과한 결과
   * @returns {{state:Object, added:number, updated:number, removed:number, notes:string[]}}
   */
  function mergeResult(state, incoming) {
    const base = state && Array.isArray(state.items) ? state : emptyState();
    const notes = [];
    const byKey = new Map();
    base.items.forEach((it) => byKey.set(it.key || schema.itemKey(it), it));

    let added = 0;
    let updated = 0;
    const incomingKeys = new Set();

    (incoming.items || []).forEach((it) => {
      const key = it.key || schema.itemKey(it);
      if (!key) return;
      incomingKeys.add(key);
      if (byKey.has(key)) {
        const prev = byKey.get(key);
        byKey.set(key, Object.assign({}, prev, it));
        updated++;
      } else {
        byKey.set(key, it);
        added++;
      }
    });

    // 완전 수집으로 확인된 범위만 정리한다
    let removed = 0;
    (incoming.sourceResults || []).forEach((sr) => {
      if (!sr.complete) {
        if (sr.status && sr.status !== "ok" && sr.status !== "empty") {
          notes.push(`${sr.sourceId}: ${sr.status} — 기존 데이터를 유지하고 추가만 했습니다`);
        }
        return;
      }
      const scope = schema.scopeKey(sr);
      byKey.forEach((it, key) => {
        if (it.sourceId !== sr.sourceId) return;
        if (it.scopeId !== scope) return; // 다른 범위(다른 브랜드 조회 등)는 건드리지 않는다
        if (incomingKeys.has(key)) return;
        byKey.delete(key);
        removed++;
      });
      if (removed) notes.push(`${sr.sourceId}: 완전 수집 범위에서 사라진 ${removed}건 정리`);
    });

    // 개별 상품 상태 확인 (404/품절) — 지우지 않고 상태만 바꾼다
    (incoming.itemStatuses || []).forEach((st) => {
      if (!st || !st.key) return;
      const prev = byKey.get(st.key);
      if (!prev) return;
      byKey.set(st.key, Object.assign({}, prev, { availability: st.availability || "gone", statusCheckedAt: incoming.collectedAt }));
    });

    // 판매처 결과는 sourceId+scope 단위로 최신값 유지
    const srMap = new Map();
    base.sourceResults.forEach((sr) => srMap.set(schema.scopeKey(sr), sr));
    (incoming.sourceResults || []).forEach((sr) => srMap.set(schema.scopeKey(sr), sr));

    return {
      state: {
        items: [...byKey.values()],
        sourceResults: [...srMap.values()],
        updatedAt: incoming.collectedAt || new Date().toISOString(),
      },
      added,
      updated,
      removed,
      notes,
    };
  }

  /**
   * /api/scan의 페이지 조각(chunk)을 하나의 실행 결과로 누적한다.
   * 조각 하나를 완전 스냅샷처럼 쓰면 안 되기 때문에, 웹은 이 누적기를 통해서만
   * 병합한다. 시작부터 끝까지 오류 없이 소비했을 때만 complete=true가 된다.
   */
  function createAccumulator(runId) {
    const items = new Map();
    const sources = new Map(); // sourceId::scope → 누적 상태
    let aborted = false;

    return {
      runId,
      /** @param {{items:Array, sourceResults:Array}} chunk */
      add(chunk) {
        (chunk.items || []).forEach((it) => {
          const key = it.key || schema.itemKey(it);
          if (key) items.set(key, it);
        });
        (chunk.sourceResults || []).forEach((sr) => {
          const k = schema.scopeKey(sr);
          const prev = sources.get(k);
          if (!prev) {
            sources.set(k, Object.assign({}, sr));
            return;
          }
          const merged = Object.assign({}, prev, sr);
          merged.discovered = (prev.discovered || 0) + (sr.discovered || 0);
          merged.fetched = (prev.fetched || 0) + (sr.fetched || 0);
          merged.accepted = (prev.accepted || 0) + (sr.accepted || 0);
          merged.rejected = (prev.rejected || 0) + (sr.rejected || 0);
          merged.pages = (prev.pages || 0) + (sr.pages || 0);
          // 한 번이라도 정상이 아니었으면 그 범위는 완전 수집이 아니다
          if (prev.status !== "ok" && prev.status !== "empty") merged.status = prev.status;
          sources.set(k, merged);
        });
      },
      abort() {
        aborted = true;
      },
      /** @param {boolean} finished nextCursor를 끝까지 소비했는가 */
      finalize(finished) {
        const sourceResults = [...sources.values()].map((sr) => {
          const complete =
            !aborted && finished && !sr.nextCursor && (sr.status === "ok" || sr.status === "empty");
          return Object.assign({}, sr, { complete });
        });
        return {
          schemaVersion: schema.SCHEMA_VERSION,
          runId,
          collectedAt: new Date().toISOString(),
          sourceResults,
          items: [...items.values()],
        };
      },
      get size() {
        return items.size;
      },
    };
  }

  /** 수집 시각이 오래된 상품인지 (기본 24시간) */
  function isStale(item, now, maxAgeMs) {
    const ts = Date.parse(item && (item.collectedAt || item.statusCheckedAt) ? item.collectedAt || item.statusCheckedAt : "");
    if (!Number.isFinite(ts)) return false;
    const limit = maxAgeMs || 24 * 60 * 60 * 1000;
    return (now || Date.now()) - ts > limit;
  }

  return { emptyState, mergeResult, createAccumulator, isStale };
});
