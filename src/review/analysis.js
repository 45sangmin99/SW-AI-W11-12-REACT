// 리뷰 이상 신호 탐지 (순수 함수). 화면(DOM)이나 Hook에 의존하지 않아 단위 테스트가 쉽다.
// 날짜는 모두 UTC 기준의 "YYYY-MM-DD" 문자열로 다룬다 (브라우저 시간대에 따라 결과가 달라지지 않게).
import { CONFIG } from "./config.js";

export const SIGNAL_LABEL = Object.freeze({ surge: "리뷰 급증", skew: "평점 쏠림", repeat: "반복 문구" });
export const SEVERITY_LABEL = Object.freeze({ high: "높음", medium: "중간", low: "낮음" });
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const TYPE_ORDER = { surge: 0, skew: 1, repeat: 2 };

const DAY_MS = 86_400_000;
export const dayOf = (iso) => iso.slice(0, 10);
const dayToMs = (day) => Date.parse(`${day}T00:00:00Z`);
const msToDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** from~to(포함)의 모든 날짜. 리뷰가 없는 날도 포함해야 "평소 수준"이 왜곡되지 않는다 */
export function eachDay(from, to) {
  const days = [];
  for (let ms = dayToMs(from); ms <= dayToMs(to); ms += DAY_MS) days.push(msToDay(ms));
  return days;
}

/** 데이터에서 가장 최근 리뷰의 날짜. 비어 있으면 null (기간 필터의 기준일) */
export function latestDay(reviews) {
  let latest = null;
  for (const r of reviews) {
    const d = dayOf(r.created_at);
    if (latest === null || d > latest) latest = d;
  }
  return latest;
}

const byNewest = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;

// ---------------------------------------------------------------- 필터 · 요약
/**
 * 검색어(상품 ID에 포함), 기간(기준일로부터 최근 N일), 평점으로 거른다.
 * @param filters { query: string, period: "all"|"7"|..., rating: "all"|"1"~"5" }
 * @param baseDay 기간 필터의 기준일 (보통 전체 데이터의 latestDay)
 */
export function filterReviews(reviews, { query = "", period = "all", rating = "all" } = {}, baseDay = latestDay(reviews)) {
  const q = String(query).trim().toLowerCase();
  const days = CONFIG.PERIODS.find((p) => p.value === String(period))?.days ?? null;
  const since = days !== null && baseDay ? msToDay(dayToMs(baseDay) - (days - 1) * DAY_MS) : null;
  const wantedRating = rating === "all" || rating === "" ? null : Number(rating);
  return reviews.filter((r) => {
    if (q && !r.product_id.toLowerCase().includes(q)) return false;
    if (since && dayOf(r.created_at) < since) return false;
    if (wantedRating !== null && r.rating !== wantedRating) return false;
    return true;
  });
}

/** 평균 별점(소수 첫째 자리)과 리뷰 수. 리뷰가 없으면 average는 null */
export function summarize(reviews) {
  if (reviews.length === 0) return { count: 0, average: null };
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return { count: reviews.length, average: Math.round((sum / reviews.length) * 10) / 10 };
}

function groupByProduct(reviews) {
  const groups = new Map();
  for (const r of reviews) {
    if (!groups.has(r.product_id)) groups.set(r.product_id, []);
    groups.get(r.product_id).push(r);
  }
  return groups;
}

/** 날짜별 건수. days 순서대로 { label, value } */
function dailyBars(reviews, days, highlightDays = new Set()) {
  const counts = new Map(days.map((d) => [d, 0]));
  for (const r of reviews) {
    const d = dayOf(r.created_at);
    if (counts.has(d)) counts.set(d, counts.get(d) + 1);
  }
  return days.map((d) => ({ label: d, value: counts.get(d), highlight: highlightDays.has(d) }));
}

// ---------------------------------------------------------------- 리뷰 급증
export function detectSurge(reviews, productId) {
  if (reviews.length === 0) return null;
  const days = eachDay(
    dayOf(reviews.reduce((a, r) => (r.created_at < a ? r.created_at : a), reviews[0].created_at)),
    dayOf(reviews.reduce((a, r) => (r.created_at > a ? r.created_at : a), reviews[0].created_at)),
  );
  if (days.length < CONFIG.SURGE_MIN_DAYS) return null; // 평소 수준을 구하기에 기간이 너무 짧다

  const bars = dailyBars(reviews, days);
  const counts = bars.map((b) => b.value);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const std = Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length);
  if (std === 0) return null; // 매일 똑같으면 튀는 날이 없다

  const limit = Math.max(CONFIG.SURGE_MIN_COUNT, mean + CONFIG.SURGE_Z * std);
  const surgeDays = new Set(bars.filter((b) => b.value >= limit).map((b) => b.label));
  if (surgeDays.size === 0) return null;

  const peak = bars.reduce((a, b) => (b.value > a.value ? b : a));
  const z = (peak.value - mean) / std;
  const severity = z >= CONFIG.SURGE_Z_HIGH ? "high" : z >= CONFIG.SURGE_Z_MEDIUM ? "medium" : "low";
  const surgeLabel = surgeDays.size === 1 ? peak.label : `${peak.label} 외 ${surgeDays.size - 1}일`;

  return {
    id: `surge:${productId}`,
    type: "surge",
    product_id: productId,
    severity,
    score: z,
    reason:
      `${surgeLabel}에 하루 최대 ${peak.value}건이 등록됐습니다. ` +
      `이 상품의 일 평균 ${mean.toFixed(1)}건의 ${(peak.value / mean).toFixed(1)}배이고, 평균에서 표준편차의 ${z.toFixed(1)}배만큼 벗어났습니다. ` +
      `(기준: 평균 + 표준편차 ${CONFIG.SURGE_Z}배 이상이면서 ${CONFIG.SURGE_MIN_COUNT}건 이상인 날)`,
    chartTitle: "일별 리뷰 수",
    bars: bars.map((b) => ({ ...b, highlight: surgeDays.has(b.label) })),
    evidence: reviews.filter((r) => surgeDays.has(dayOf(r.created_at))).sort(byNewest),
  };
}

// ---------------------------------------------------------------- 평점 쏠림
export function detectSkew(reviews, productId) {
  const n = reviews.length;
  if (n < CONFIG.SKEW_MIN_REVIEWS) return null; // 표본이 적으면 쏠림이라 말하기 어렵다
  const counts = [0, 0, 0, 0, 0, 0]; // 인덱스 = 평점 (0번 칸은 쓰지 않음)
  for (const r of reviews) counts[r.rating]++;
  let dominant = 1;
  for (let star = 2; star <= 5; star++) if (counts[star] > counts[dominant]) dominant = star;
  const share = counts[dominant] / n;
  if (share < CONFIG.SKEW_RATIO) return null;

  const severity = share >= CONFIG.SKEW_RATIO_HIGH ? "high" : share >= CONFIG.SKEW_RATIO_MEDIUM ? "medium" : "low";
  return {
    id: `skew:${productId}`,
    type: "skew",
    product_id: productId,
    severity,
    score: share,
    reason:
      `리뷰 ${n}건 중 ${counts[dominant]}건(${(share * 100).toFixed(1)}%)이 ${dominant}점입니다. ` +
      `(기준: 한 평점이 ${CONFIG.SKEW_RATIO * 100}% 이상이면서 ${CONFIG.SKEW_MIN_REVIEWS}건 이상)`,
    chartTitle: "평점 분포",
    bars: [1, 2, 3, 4, 5].map((star) => ({ label: `${star}점`, value: counts[star], highlight: star === dominant })),
    evidence: reviews.filter((r) => r.rating === dominant).sort(byNewest),
  };
}

// ---------------------------------------------------------------- 반복 문구
/** 구두점·기호를 지우고 공백을 정리한 비교용 문장 */
export function normalizePhrase(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** 문장 부호로 문장을 나눈다. 구분자를 남겨 두어서 이어 붙이면 원문이 그대로 복원된다 */
const SENTENCE_SPLIT = /([.!?。\n]+)/;

/** 리뷰 한 건에서 (정규화된) 비교 대상 문장 집합 */
function phraseKeys(text) {
  const keys = new Set();
  for (const piece of String(text).split(SENTENCE_SPLIT)) {
    const key = normalizePhrase(piece);
    if (key.length >= CONFIG.REPEAT_MIN_PHRASE_LEN) keys.add(key);
  }
  return keys;
}

export function detectRepeat(reviews, productId) {
  const found = new Map(); // key -> { ids:Set, text }
  for (const r of reviews) {
    const keys = phraseKeys(r.text);
    for (const piece of String(r.text).split(SENTENCE_SPLIT)) {
      const key = normalizePhrase(piece);
      if (!keys.has(key)) continue;
      if (!found.has(key)) found.set(key, { ids: new Set(), text: piece.trim() });
      found.get(key).ids.add(r.id); // 한 리뷰 안에서 여러 번 나와도 1건으로 센다
    }
  }
  const repeated = [...found.entries()].filter(([, v]) => v.ids.size >= CONFIG.REPEAT_MIN_REVIEWS);
  if (repeated.length === 0) return null;

  repeated.sort((a, b) => b[1].ids.size - a[1].ids.size);
  const repeatedIds = new Set(repeated.flatMap(([, v]) => [...v.ids]));
  const evidence = reviews.filter((r) => repeatedIds.has(r.id)).sort(byNewest);
  const count = evidence.length;
  const severity = count >= CONFIG.REPEAT_HIGH ? "high" : count >= CONFIG.REPEAT_MEDIUM ? "medium" : "low";

  const sorted = [...reviews].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const days = eachDay(dayOf(sorted[0].created_at), dayOf(sorted.at(-1).created_at));
  const top = repeated[0];
  return {
    id: `repeat:${productId}`,
    type: "repeat",
    product_id: productId,
    severity,
    score: count,
    reason:
      `같은 문장이 서로 다른 리뷰 ${top[1].ids.size}건에 반복됩니다: "${top[1].text}". ` +
      `반복 문구가 들어간 리뷰는 모두 ${count}건입니다. ` +
      `(기준: 정규화한 문장이 ${CONFIG.REPEAT_MIN_REVIEWS}건 이상의 리뷰에 등장, ${CONFIG.REPEAT_MIN_PHRASE_LEN}자 이상)`,
    chartTitle: "일별 반복 문구 리뷰 수",
    bars: dailyBars(evidence, days).map((b) => ({ ...b, highlight: b.value > 0 })),
    evidence,
    phrases: repeated.map(([key, v]) => ({ key, text: v.text, count: v.ids.size })),
  };
}

/**
 * 근거 리뷰 본문을 "반복 문구인 문장"과 아닌 문장 조각으로 나눈다 (F-06 강조용).
 * 조각을 이어 붙이면 원문과 같다.
 * @returns Array<{ text: string, mark: boolean }>
 */
export function highlightSegments(text, phrases = []) {
  const keys = new Set(phrases.map((p) => p.key));
  const segments = [];
  for (const piece of String(text).split(SENTENCE_SPLIT)) {
    if (piece === "") continue;
    const mark = keys.has(normalizePhrase(piece));
    const last = segments.at(-1);
    if (last && last.mark === mark) last.text += piece;
    else segments.push({ text: piece, mark });
  }
  return segments;
}

// ---------------------------------------------------------------- 신호 목록
/**
 * 필터가 적용된 리뷰에서 상품별로 이상 신호를 찾아 심각도순으로 정렬해 돌려준다 (R-02, F-04).
 * @param options.skipSkew 평점 필터가 켜져 있으면 true. 한 평점만 남긴 데이터는 당연히 100% 쏠려 보이므로 쏠림은 계산하지 않는다
 */
export function detectSignals(reviews, { skipSkew = false } = {}) {
  const signals = [];
  for (const [productId, list] of groupByProduct(reviews)) {
    for (const found of [detectSurge(list, productId), skipSkew ? null : detectSkew(list, productId), detectRepeat(list, productId)]) {
      if (found) signals.push(found);
    }
  }
  return signals.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      b.score - a.score ||
      a.product_id.localeCompare(b.product_id),
  );
}
