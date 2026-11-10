// 고객 문의(VOC) 이상 신호 탐지 (순수 함수). 화면(DOM)이나 Hook에 의존하지 않아 단위 테스트가 쉽다.
// 시간은 모두 UTC 기준의 "시(hour)" 문자열("2026-11-09T10")로 다룬다 (브라우저 시간대에 따라 결과가 달라지지 않게).
//
// 판정 방식 (승인된 설계): 데이터 전체를 1시간 단위로 훑어서 기준을 넘은 시각을 찾고,
// 연속된 시각은 하나의 "발생 건(alert)"으로 합친다.
import { CONFIG } from "./config.js";

export const SIGNAL_LABEL = Object.freeze({ surge: "문의 급증", category: "유형 쏠림", env: "기기·버전 쏠림", repeat: "반복 문구" });
export const SEVERITY_LABEL = Object.freeze({ high: "높음", medium: "중간", low: "낮음" });
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const TYPE_ORDER = { surge: 0, category: 1, env: 2, repeat: 3 };
const EPS = 1e-9; // 0.7 같은 비율을 부동소수점으로 비교할 때 경계가 흔들리지 않게

// ---------------------------------------------------------------- 시간 도우미
const HOUR_MS = 3_600_000;
export const hourOf = (iso) => iso.slice(0, 13); // "2026-11-09T10"
const hourToMs = (hour) => Date.parse(`${hour}:00:00Z`);
const msToHour = (ms) => new Date(ms).toISOString().slice(0, 13);
export const hourOfDay = (hour) => Number(hour.slice(11, 13));

/** from~to(포함)의 모든 시각. 문의가 없는 시각도 포함해야 "평소 수준"이 왜곡되지 않는다 */
export function eachHour(from, to) {
  const hours = [];
  for (let ms = hourToMs(from); ms <= hourToMs(to); ms += HOUR_MS) hours.push(msToHour(ms));
  return hours;
}

/** 데이터의 첫 시각과 마지막 시각. 비어 있으면 null */
export function hourRange(inquiries) {
  let from = null;
  let to = null;
  for (const q of inquiries) {
    const h = hourOf(q.created_at);
    if (from === null || h < from) from = h;
    if (to === null || h > to) to = h;
  }
  return from === null ? null : { from, to };
}

export const formatHour = (hour) => `${hour.slice(0, 10)} ${hour.slice(11)}:00`;

/** 발생 구간 표시. 같은 날이면 날짜를 한 번만 쓴다 */
export function formatRange(startHour, endHour) {
  const [d1, h1, d2, h2] = [startHour.slice(0, 10), startHour.slice(11), endHour.slice(0, 10), endHour.slice(11)];
  if (d1 === d2) return `${d1} ${h1}:00~${h2}:59`;
  return `${d1} ${h1}:00 ~ ${d2} ${h2}:59`;
}

/**
 * 카드용 짧은 구간 표시. 연도와 분은 reason에 정확히 있으므로 뺀다 (끝 시각은 그 시 정각까지, 즉 12시대면 13시).
 * 예: "11-09 09~13시", 날짜가 다르면 "11-08 22시~11-09 02시"
 */
export function formatRangeShort(startHour, endHour) {
  const [d1, h1, d2, h2] = [startHour.slice(5, 10), startHour.slice(11), endHour.slice(5, 10), endHour.slice(11)];
  const end = String(Number(h2) + 1).padStart(2, "0");
  return d1 === d2 ? `${d1} ${h1}~${end}시` : `${d1} ${h1}시~${d2} ${end}시`;
}

// ---------------------------------------------------------------- 필터 · 요약
/** 검색어(문의 내용에 포함), 유형, 기기, 앱 버전으로 거른다. 기간은 따로 다룬다 (아래 sinceHour) */
export function filterInquiries(list, { query = "", category = "all", device = "all", appVersion = "all" } = {}) {
  const q = String(query).trim().toLowerCase();
  return list.filter(
    (r) =>
      (!q || r.text.toLowerCase().includes(q)) &&
      (category === "all" || r.category === category) &&
      (device === "all" || r.device === device) &&
      (appVersion === "all" || r.app_version === appVersion),
  );
}

/** 기간 필터의 시작 시각(포함). "전체"이거나 기준이 없으면 null */
export function sinceHour(period, lastHour) {
  const hours = CONFIG.PERIODS.find((p) => p.value === String(period))?.hours ?? null;
  if (hours === null || !lastHour) return null;
  return msToHour(hourToMs(lastHour) - (hours - 1) * HOUR_MS);
}

export const inPeriod = (iso, since) => since === null || hourOf(iso) >= since;

/** 문의 수와 가장 많은 유형. 동률이면 CATEGORIES 순서가 앞선 유형 */
export function summarize(inquiries) {
  const counts = new Map();
  for (const r of inquiries) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  let topCategory = null;
  let topCount = 0;
  for (const category of CONFIG.CATEGORIES) {
    const n = counts.get(category) ?? 0;
    if (n > topCount) [topCategory, topCount] = [category, n];
  }
  return { count: inquiries.length, topCategory, topCount };
}

// ---------------------------------------------------------------- 반복 문구 정규화 (U-14, 승인: 문장 단위 + 숫자 마스킹)
/** 소문자로 바꾸고, 숫자는 #으로 가리고, 기호를 지우고, 공백을 정리한 비교용 문장 */
export function normalizePhrase(text) {
  return String(text).toLowerCase().replace(/\d+/g, "#").replace(/[^\p{L}\s#]/gu, " ").replace(/\s+/g, " ").trim();
}

/** 문장 부호로 문장을 나눈다. 구분자를 남겨 두어서 이어 붙이면 원문이 그대로 복원된다 */
const SENTENCE_SPLIT = /([.!?。\n]+)/;

// 문의 한 건의 (정규화 문장 → 처음 나온 원문) 목록. 문의 객체는 바뀌지 않으므로 한 번만 계산해 둔다
const entryCache = new WeakMap();
function phraseEntries(inquiry) {
  let entries = entryCache.get(inquiry);
  if (!entries) {
    const seen = new Map();
    for (const piece of String(inquiry.text).split(SENTENCE_SPLIT)) {
      const key = normalizePhrase(piece);
      if (key.length >= CONFIG.REPEAT_MIN_PHRASE_LEN && !seen.has(key)) seen.set(key, piece.trim());
    }
    entries = [...seen].map(([key, text]) => ({ key, text }));
    entryCache.set(inquiry, entries);
  }
  return entries;
}

/**
 * 근거 문의 본문을 "반복 문구인 문장"과 아닌 문장 조각으로 나눈다 (F-06 강조용).
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

// ---------------------------------------------------------------- 탐지
const byNewest = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
const severityBySteps = (value, medium, high) => (value + EPS >= high ? "high" : value + EPS >= medium ? "medium" : "low");
const pct = (ratio) => Math.round(ratio * 100);

/**
 * 필터가 적용된 문의에서 4가지 이상 신호의 발생 건을 찾아 심각도순으로 돌려준다 (R-02, F-04).
 * @param inquiries 검색·유형·기기·버전 필터를 적용한 문의 (기간 필터는 적용하지 않는다: "평소" 이력을 자르지 않기 위해)
 * @param options.from, options.to 훑을 시간 범위. 필터와 상관없이 전체 데이터의 범위를 넘겨야 한다 (hourRange)
 * @param options.skipCategory 유형 필터가 켜져 있으면 true. 한 유형만 남으면 비율이 의미 없으므로 유형 쏠림을 계산하지 않는다
 * @param options.skipDevice, options.skipVersion 기기·버전 필터가 켜져 있으면 true. 해당 항목의 쏠림은 계산하지 않는다
 */
export function detectAlerts(inquiries, { from, to, skipCategory = false, skipDevice = false, skipVersion = false } = {}) {
  if (!from || !to) return [];
  const hours = eachHour(from, to);
  const H = hours.length;
  if (H === 0) return [];

  // 시각별·유형별 건수와 문의 목록
  const indexOf = new Map(hours.map((h, i) => [h, i]));
  const counts = Object.fromEntries(CONFIG.CATEGORIES.map((c) => [c, new Array(H).fill(0)]));
  const totals = new Array(H).fill(0);
  const byHour = Array.from({ length: H }, () => []);
  for (const q of inquiries) {
    const i = indexOf.get(hourOf(q.created_at));
    if (i === undefined || !counts[q.category]) continue;
    counts[q.category][i]++;
    totals[i]++;
    byHour[i].push(q);
  }
  const ctx = { hours, H, counts, byHour };
  const hits = [];

  // 1) 문의 급증: 유형별. 같은 시각(0~23시)의 과거 평균과 비교
  for (const category of CONFIG.CATEGORIES) {
    const series = counts[category];
    const sum = new Array(24).fill(0);
    const seen = new Array(24).fill(0);
    for (let i = 0; i < H; i++) {
      const hod = hourOfDay(hours[i]);
      if (seen[hod] >= CONFIG.HISTORY_MIN_DAYS) {
        const avg = sum[hod] / seen[hod];
        if (series[i] >= CONFIG.SURGE_MIN_COUNT && series[i] >= CONFIG.SURGE_RATIO * avg) {
          hits.push({ type: "surge", scope: category, category, i, value: series[i], avg });
        }
      }
      sum[hod] += series[i];
      seen[hod]++;
    }
  }

  // 2) 유형 쏠림: 그 시각의 유형 비율을 "그 이전 전체" 비율과 비교
  if (!skipCategory) {
    const before = Object.fromEntries(CONFIG.CATEGORIES.map((c) => [c, 0]));
    let beforeTotal = 0;
    for (let i = 0; i < H; i++) {
      if (i >= CONFIG.HISTORY_MIN_DAYS * 24 && totals[i] >= CONFIG.CATEGORY_MIN_COUNT && beforeTotal > 0) {
        for (const category of CONFIG.CATEGORIES) {
          const now = counts[category][i] / totals[i];
          const usual = before[category] / beforeTotal;
          if (now - usual >= CONFIG.CATEGORY_DIFF - EPS) {
            hits.push({ type: "category", scope: category, category, i, now, usual, diff: now - usual, total: totals[i] });
          }
        }
      }
      for (const category of CONFIG.CATEGORIES) before[category] += counts[category][i];
      beforeTotal += totals[i];
    }
  }

  // 3) 기기·버전 쏠림: 유형별 한 시간 구간에서 한 기기/앱 버전이 70% 이상
  if (!(skipDevice && skipVersion)) {
    for (const category of CONFIG.CATEGORIES) {
      for (let i = 0; i < H; i++) {
        const n = counts[category][i];
        if (n < CONFIG.ENV_MIN_COUNT) continue;
        const list = byHour[i].filter((q) => q.category === category);
        const dims = {};
        const device = skipDevice ? null : topShare(list.map((q) => q.device), n);
        if (device && device.share >= CONFIG.ENV_SHARE - EPS) dims.device = device;
        // "web"은 앱 버전이 아니라 Web 기기의 표시값이므로 버전 쏠림 후보에서 뺀다
        const version = skipVersion ? null : topShare(list.map((q) => q.app_version).filter((v) => v !== "web"), n);
        if (version && version.share >= CONFIG.ENV_SHARE - EPS) dims.version = version;
        if (dims.device || dims.version) hits.push({ type: "env", scope: category, category, i, n, dims });
      }
    }
  }

  // 4) 반복 문구: 같은 (정규화한) 문장이 한 시간 안에 10건 이상
  for (let i = 0; i < H; i++) {
    if (byHour[i].length < CONFIG.REPEAT_MIN_COUNT) continue;
    const found = new Map();
    for (const q of byHour[i]) {
      for (const { key, text } of phraseEntries(q)) {
        if (!found.has(key)) found.set(key, { ids: new Set(), text });
        found.get(key).ids.add(q.id); // 한 문의 안에서 같은 문장이 여러 번 나와도 1건
      }
    }
    for (const [key, entry] of found) {
      if (entry.ids.size >= CONFIG.REPEAT_MIN_COUNT) hits.push({ type: "repeat", scope: key, key, i, count: entry.ids.size, text: entry.text });
    }
  }

  const build = { surge: buildSurge, category: buildCategory, env: buildEnv, repeat: buildRepeat };
  return toRuns(hits)
    .map((run) => build[run[0].type](run, ctx))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.endHour.localeCompare(a.endHour) ||
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        a.id.localeCompare(b.id),
    );
}

/** 가장 많은 값과 그 비율. total은 분모(그 구간의 전체 건수) */
function topShare(values, total) {
  const tally = new Map();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = null;
  for (const [value, count] of tally) if (!best || count > best.count) best = { value, count };
  return best && { ...best, share: best.count / total };
}

/** 같은 (유형, 범위)의 기준 초과 시각 중 연속된 것을 하나의 구간(run)으로 합친다 */
function toRuns(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const key = `${hit.type}|${hit.scope}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hit);
  }
  const runs = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.i - b.i);
    let current = [list[0]];
    for (let j = 1; j < list.length; j++) {
      if (list[j].i === current.at(-1).i + 1) current.push(list[j]);
      else {
        runs.push(current);
        current = [list[j]];
      }
    }
    runs.push(current);
  }
  return runs;
}

// ---------------------------------------------------------------- 발생 건 만들기 (이유·차트·근거 문의)
const spanOf = (run, ctx) => ({ start: run[0].i, end: run.at(-1).i, startHour: ctx.hours[run[0].i], endHour: ctx.hours[run.at(-1).i] });

function windowInquiries(ctx, start, end, predicate = () => true) {
  const out = [];
  for (let i = start; i <= end; i++) for (const q of ctx.byHour[i]) if (predicate(q)) out.push(q);
  return out.sort(byNewest);
}

/** 발생 구간 앞뒤로 시간을 조금 더 붙여서 "평소와 얼마나 다른지" 보이게 하는 시간별 막대 */
function hourlyBars(ctx, series, start, end) {
  const lo = Math.max(0, start - CONFIG.CHART_PAD_BEFORE);
  const hi = Math.min(ctx.H - 1, end + CONFIG.CHART_PAD_AFTER);
  const bars = [];
  for (let i = lo; i <= hi; i++) {
    const hour = ctx.hours[i];
    bars.push({ label: formatHour(hour), short: `${hour.slice(5, 10)} ${hour.slice(11)}시`, value: series[i], highlight: i >= start && i <= end });
  }
  return bars;
}

function buildSurge(run, ctx) {
  const { start, end, startHour, endHour } = spanOf(run, ctx);
  const category = run[0].category;
  const peak = run.reduce((a, h) => (h.value > a.value ? h : a));
  const ratio = peak.value / Math.max(peak.avg, CONFIG.SURGE_AVG_FLOOR);
  return {
    id: `surge:${category}:${startHour}`,
    type: "surge",
    category,
    scopeLabel: category,
    metricLabel: `평소의 ${ratio.toFixed(1)}배`, // 카드에서 "얼마나"를 평소와 비교해 말한다 (정확한 건수는 reason에)
    startHour,
    endHour,
    severity: severityBySteps(ratio, CONFIG.SURGE_RATIO_MEDIUM, CONFIG.SURGE_RATIO_HIGH),
    score: ratio,
    reason:
      `${formatRange(startHour, endHour)} 동안 '${category}' 문의가 한 시간에 최대 ${peak.value}건 접수됐습니다. ` +
      `같은 시각의 평소 평균 ${peak.avg.toFixed(1)}건의 ${ratio.toFixed(1)}배입니다. ` +
      `(기준: 같은 시간대 평균의 ${CONFIG.SURGE_RATIO}배 이상이면서 ${CONFIG.SURGE_MIN_COUNT}건 이상. 평균이 ${CONFIG.SURGE_AVG_FLOOR}건 미만이면 ${CONFIG.SURGE_AVG_FLOOR}건으로 보고 배수를 계산)`,
    charts: [{ title: `시간별 문의 수 — ${category}`, bars: hourlyBars(ctx, ctx.counts[category], start, end) }],
    evidence: windowInquiries(ctx, start, end, (q) => q.category === category),
  };
}

function buildCategory(run, ctx) {
  const { start, end, startHour, endHour } = spanOf(run, ctx);
  const category = run[0].category;
  const peak = run.reduce((a, h) => (h.diff > a.diff ? h : a));
  const window = windowInquiries(ctx, start, end);
  const tally = Object.fromEntries(CONFIG.CATEGORIES.map((c) => [c, 0]));
  for (const q of window) tally[q.category]++;
  return {
    id: `category:${category}:${startHour}`,
    type: "category",
    category,
    scopeLabel: category,
    metricLabel: `평소보다 +${pct(peak.diff)}%p`,
    startHour,
    endHour,
    severity: severityBySteps(peak.diff, CONFIG.CATEGORY_DIFF_MEDIUM, CONFIG.CATEGORY_DIFF_HIGH),
    score: peak.diff,
    reason:
      `${formatRange(startHour, endHour)} 동안 '${category}' 문의가 한 시간 전체 ${peak.total}건 중 ${pct(peak.now)}%로, ` +
      `평소 비율 ${pct(peak.usual)}%보다 ${pct(peak.diff)}%p 높습니다. ` +
      `(기준: 평소보다 ${pct(CONFIG.CATEGORY_DIFF)}%p 이상 높고, 그 한 시간 문의가 ${CONFIG.CATEGORY_MIN_COUNT}건 이상)`,
    charts: [{ title: "문의 유형 분포 (발생 구간)", bars: CONFIG.CATEGORIES.map((c) => ({ label: c, value: tally[c], highlight: c === category })) }],
    evidence: window.filter((q) => q.category === category),
  };
}

function buildEnv(run, ctx) {
  const { start, end, startHour, endHour } = spanOf(run, ctx);
  const category = run[0].category;
  const strength = (hit) => Math.max(hit.dims.device?.share ?? 0, hit.dims.version?.share ?? 0);
  const peak = run.reduce((a, h) => (strength(h) > strength(a) ? h : a));
  const flaggedDevices = new Set(run.flatMap((h) => (h.dims.device ? [h.dims.device.value] : [])));
  const flaggedVersions = new Set(run.flatMap((h) => (h.dims.version ? [h.dims.version.value] : [])));
  const window = windowInquiries(ctx, start, end, (q) => q.category === category);

  const parts = [];
  if (peak.dims.device) parts.push(`${peak.dims.device.value} 기기 ${pct(peak.dims.device.share)}%`);
  if (peak.dims.version) parts.push(`앱 ${peak.dims.version.value} 버전 ${pct(peak.dims.version.share)}%`);
  const tally = (pick) => {
    const m = new Map();
    for (const q of window) m.set(pick(q), (m.get(pick(q)) ?? 0) + 1);
    return m;
  };
  const deviceCounts = tally((q) => q.device);
  const versionCounts = tally((q) => q.app_version);
  const versions = [...versionCounts.keys()].filter((v) => v !== "web").sort();
  return {
    id: `env:${category}:${startHour}`,
    type: "env",
    category,
    scopeLabel: category,
    metricLabel: [
      peak.dims.device && `${peak.dims.device.value} ${pct(peak.dims.device.share)}%`,
      peak.dims.version && `앱 ${peak.dims.version.value} ${pct(peak.dims.version.share)}%`,
    ].filter(Boolean).join(" · "),
    startHour,
    endHour,
    severity: severityBySteps(strength(peak), CONFIG.ENV_SHARE_MEDIUM, CONFIG.ENV_SHARE_HIGH),
    score: strength(peak),
    reason:
      `${formatRange(startHour, endHour)} 동안 '${category}' 문의가 한 시간에 ${peak.n}건 중 ${parts.join(", ")}를 차지합니다. ` +
      `(기준: 한 기기 또는 앱 버전이 ${pct(CONFIG.ENV_SHARE)}% 이상이면서 ${CONFIG.ENV_MIN_COUNT}건 이상)`,
    // C5: 기기별 막대와 앱 버전별 막대
    charts: [
      { title: "기기별 문의 수 (발생 구간)", bars: CONFIG.DEVICES.map((d) => ({ label: d, value: deviceCounts.get(d) ?? 0, highlight: flaggedDevices.has(d) })) },
      { title: "앱 버전별 문의 수 (발생 구간)", bars: versions.map((v) => ({ label: v, value: versionCounts.get(v) ?? 0, highlight: flaggedVersions.has(v) })) },
    ],
    evidence: window,
  };
}

function buildRepeat(run, ctx) {
  const { start, end, startHour, endHour } = spanOf(run, ctx);
  const { key } = run[0];
  const peak = run.reduce((a, h) => (h.count > a.count ? h : a));
  // 화면에는 숫자를 #으로 가려서 보여준다: 문의마다 다른 주문번호 하나가 "그 문구"인 것처럼 보이지 않게
  const shown = peak.text.replace(/\d+/g, "#");
  const hasPhrase = (q) => phraseEntries(q).some((e) => e.key === key);
  const evidence = windowInquiries(ctx, start, end, hasPhrase);
  // 시간별 반복 발생 수: 이 문구가 들어간 문의가 시각마다 몇 건인지
  const series = ctx.byHour.map((list) => list.reduce((n, q) => n + (hasPhrase(q) ? 1 : 0), 0));
  return {
    id: `repeat:${hashKey(key)}:${startHour}`,
    type: "repeat",
    category: null,
    scopeLabel: shown,
    metricLabel: `한 시간 최대 ${peak.count}건 반복`,
    startHour,
    endHour,
    severity: severityBySteps(peak.count, CONFIG.REPEAT_MEDIUM, CONFIG.REPEAT_HIGH),
    score: peak.count,
    phrase: shown,
    reason:
      `"${shown}" 문구가 ${formatRange(startHour, endHour)} 동안 한 시간에 최대 ${peak.count}건 반복됐습니다. ` +
      `(기준: 같은 문구가 한 시간 안에 ${CONFIG.REPEAT_MIN_COUNT}건 이상. 문장 단위로 비교하고 숫자는 #으로 가려서 같은 문구로 봅니다)`,
    charts: [{ title: "시간별 반복 문구 문의 수", bars: hourlyBars(ctx, series, start, end) }],
    evidence,
    phrases: [{ key, text: peak.text, count: peak.count }],
  };
}

/** 긴 문구를 id에 그대로 쓰지 않으려고 짧은 해시로 줄인다 (djb2) */
function hashKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
