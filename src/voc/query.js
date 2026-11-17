// 서비스 API(/api/v1)가 돌려주는 모양을 만드는 순수 함수 모음.
// DOM·fetch·Node 전용 API를 쓰지 않아서 Node 서비스(tools/voc-service.mjs)와 브라우저가 같은 코드를 쓴다.
// 탐지 로직은 analysis.js 한 벌뿐이고, 여기서는 그 결과를 API 응답 모양으로 자르고 합치기만 한다.
import { CONFIG } from "./config.js";
import { detectAlerts, filterInquiries, hourRange, inPeriod, sinceHour, summarize } from "./analysis.js";
import { paginate } from "./pagination.js";
import { appVersionsOf } from "./data.js";
import { currentStatus, isUnresolved } from "./status.js";

/** 요청 값이 올바르지 않다 (HTTP 400) */
export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const FILTER_KEYS = ["query", "period", "category", "device", "appVersion"];
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

const blank = (v) => v === undefined || v === null || v === "";

/**
 * 조회 조건을 검증하고 하나의 모양으로 맞춘다. 같은 조건은 항상 같은 결과가 나와서 캐시 키 계산에도 쓴다.
 * 허용되지 않은 값은 QueryError (HTTP 400).
 */
export function normalizeFilters(raw = {}) {
  const pick = (key, fallback) => (blank(raw[key]) ? fallback : String(raw[key]));
  const query = pick("query", "").trim().toLowerCase(); // 검색은 대소문자를 구분하지 않으므로 소문자로 맞춰도 결과가 같다
  if (query.length > 100) throw new QueryError("query는 100자 이하여야 합니다");
  const period = pick("period", "all");
  if (!CONFIG.PERIODS.some((p) => p.value === period)) throw new QueryError(`period는 ${CONFIG.PERIODS.map((p) => p.value).join(", ")} 중 하나여야 합니다`);
  const category = pick("category", "all");
  if (category !== "all" && !CONFIG.CATEGORIES.includes(category)) throw new QueryError("category가 올바르지 않습니다");
  const device = pick("device", "all");
  if (device !== "all" && !CONFIG.DEVICES.includes(device)) throw new QueryError("device가 올바르지 않습니다");
  const appVersion = pick("appVersion", "all");
  if (appVersion.length > 20) throw new QueryError("appVersion이 올바르지 않습니다");
  return { query, period, category, device, appVersion };
}

/** 정규화한 조건의 고정된 문자열 (캐시 키의 재료) */
export const filterKey = (filters) => JSON.stringify(FILTER_KEYS.map((k) => filters[k]));

/** 정수 쿼리 값. 없으면 기본값, 범위를 벗어나거나 정수가 아니면 QueryError */
export function intParam(raw, name, fallback, min, max) {
  if (blank(raw)) return fallback;
  if (!/^\d+$/.test(String(raw))) throw new QueryError(`${name}은(는) 정수여야 합니다`);
  const n = Number(raw);
  if (n < min || n > max) throw new QueryError(`${name}은(는) ${min}~${max} 사이여야 합니다`);
  return n;
}

export function normalizeStatusFilter(raw) {
  const status = blank(raw) ? "all" : String(raw);
  if (status !== "all" && !CONFIG.STATUSES.includes(status)) throw new QueryError("status가 올바르지 않습니다");
  return status;
}

/**
 * 조건에 맞는 문의를 훑어서 요약과 이상 신호를 만든다 (필터 → 탐지 → 기간 필터 순서, 화면의 기존 규칙과 같다).
 * 반환값의 alerts는 근거 문의 전체를 들고 있는 내부 값이다. 응답으로 보낼 때는 아래 함수들로 자른다.
 */
export function analyze(inquiries, filters) {
  const range = hourRange(inquiries);
  const scoped = filterInquiries(inquiries, filters);
  const since = sinceHour(filters.period, range ? range.to : null);
  const alerts = range
    ? detectAlerts(scoped, {
        ...range,
        skipCategory: filters.category !== "all",
        skipDevice: filters.device !== "all",
        skipVersion: filters.appVersion !== "all",
      }).filter((a) => since === null || a.endHour >= since)
    : [];
  const summary = summarize(scoped.filter((q) => inPeriod(q.created_at, since)));
  return { range, since, summary, alerts, appVersions: appVersionsOf(inquiries) };
}

const CARD_FIELDS = ["id", "type", "category", "scopeLabel", "metricLabel", "startHour", "endHour", "severity", "score"];
export const toCard = (alert) => Object.fromEntries(CARD_FIELDS.map((k) => [k, alert[k]]));

/** GET /overview 의 본문 */
export const overviewOf = (a) => ({
  total: a.summary.count,
  topCategory: a.summary.topCategory,
  topCount: a.summary.topCount,
  appVersions: a.appVersions,
  range: a.range,
});

/** 상태와 무관한 신호 카드 목록 (캐시에 담는 값. 상태는 응답을 만들 때 합친다) */
export const cardsOf = (a) => a.alerts.map(toCard);

/**
 * 카드에 현재 상태를 붙이고, 상태로 거르고, 페이지로 자른다. statusMap: { 신호 ID: [{ status, at }] }
 * counts는 "상태 필터를 걸기 전" 신호의 수다 (진행 현황 필터를 바꿔도 숫자가 바뀌지 않는다).
 *   all: 지금 조건에서 감지된 신호 수 / unresolved: 그중 아직 해결되지 않은(현재 상태가 "해결"이 아닌) 신호 수
 */
export function listPage(cards, statusMap, { status = "all", page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const withStatus = cards.map((c) => ({ ...c, currentStatus: currentStatus(statusMap[c.id]) }));
  const filtered = status === "all" ? withStatus : withStatus.filter((c) => c.currentStatus === status);
  const p = paginate(filtered, page, pageSize);
  const counts = { all: withStatus.length, unresolved: withStatus.filter((c) => isUnresolved(c.currentStatus)).length };
  return { alerts: p.items, page: p.page, pageSize, total: p.total, totalPages: p.totalPages, counts };
}

/** GET /alerts/{id} 의 본문. 그 신호가 현재 조건의 결과에 없으면 null */
export function detailOf(a, id, evidencePage = 1) {
  const alert = a.alerts.find((x) => x.id === id);
  if (!alert) return null;
  const p = paginate(alert.evidence, evidencePage, CONFIG.PAGE_SIZE);
  return {
    alert: { ...toCard(alert), reason: alert.reason, charts: alert.charts, phrases: alert.phrases ?? [] },
    evidence: { items: p.items, page: p.page, pageSize: CONFIG.PAGE_SIZE, total: p.total, totalPages: p.totalPages },
  };
}
