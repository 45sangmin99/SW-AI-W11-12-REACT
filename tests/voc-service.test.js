// Step 4: 서비스 API(/api/v1)의 응답 모양(query.js), API 클라이언트(service-api.js), 통합 모드 화면(App의 api prop) 검증.
// 서버(tools/voc-service.mjs)는 이 파일이 검증하는 query.js를 그대로 쓰므로, 샘플 모드와 통합 모드의 계산 결과가 같다.
import { describe, it, assert, eq, deepEq, throws, tick } from "./runner.js";
import { mountApp } from "../src/voc/app.js";
import { parseDataset } from "../src/voc/data.js";
import { detectAlerts, hourRange } from "../src/voc/analysis.js";
import { CONFIG } from "../src/voc/config.js";
import { SaveError } from "../src/voc/status-api.js";
import { QueryError, analyze, cardsOf, detailOf, filterKey, intParam, listPage, normalizeFilters, normalizeStatusFilter, overviewOf } from "../src/voc/query.js";
import { ApiError, createServiceApi, toQuery } from "../src/voc/service-api.js";

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/inquiries.sample.json").then((r) => r.json()).then((json) => parseDataset(json)));
const ALL = normalizeFilters({});

describe("조회 조건 정규화 (query.js, U-15)", () => {
  it("비어 있으면 모두 '전체'이고, 검색어는 앞뒤 공백을 지우고 소문자로 맞춘다", () => {
    deepEq(ALL, { query: "", period: "all", category: "all", device: "all", appVersion: "all" });
    eq(normalizeFilters({ query: "  Coupon ", category: "배송" }).query, "coupon");
  });
  it("허용되지 않은 값은 QueryError(400)", () => {
    for (const raw of [{ period: "9y" }, { category: "없는유형" }, { device: "Palm" }, { appVersion: "x".repeat(21) }, { query: "a".repeat(101) }]) {
      let error;
      try { normalizeFilters(raw); } catch (e) { error = e; }
      assert(error instanceof QueryError && error.status === 400, JSON.stringify(raw));
    }
  });
  it("같은 조건은 같은 캐시 키, 다른 조건은 다른 키 (순서와 상관없이)", () => {
    eq(filterKey(normalizeFilters({ category: "배송", device: "iOS" })), filterKey(normalizeFilters({ device: "iOS", category: "배송" })));
    assert(filterKey(ALL) !== filterKey(normalizeFilters({ category: "배송" })));
    assert(filterKey(normalizeFilters({ query: " ABC" })) === filterKey(normalizeFilters({ query: "abc" })), "대소문자·공백 차이는 같은 키");
  });
  it("intParam: 기본값·범위·정수 검사, normalizeStatusFilter: 상태 이름 검사", () => {
    eq(intParam(undefined, "page", 1, 1, 10), 1);
    eq(intParam("7", "page", 1, 1, 10), 7);
    for (const bad of ["0", "11", "1.5", "-1", "abc"]) throws(() => intParam(bad, "page", 1, 1, 10));
    eq(normalizeStatusFilter(undefined), "all");
    eq(normalizeStatusFilter("조치 중"), "조치 중");
    throws(() => normalizeStatusFilter("없는 상태"));
  });
});

describe("응답 모양 만들기 (query.js): 브라우저 탐지와 같은 결과", () => {
  it("분석 결과의 신호 수와 요약이 detectAlerts·summarize를 직접 부른 것과 같다", async () => {
    const data = await loadSample();
    const direct = detectAlerts(data.inquiries, hourRange(data.inquiries));
    const analysis = analyze(data.inquiries, ALL);
    eq(analysis.alerts.length, direct.length);
    deepEq(analysis.alerts.map((a) => a.id), direct.map((a) => a.id));
    const overview = overviewOf(analysis);
    eq(overview.total, data.inquiries.length);
    assert(overview.appVersions.length > 0 && !overview.appVersions.includes("web"));
  });
  it("카드에는 근거 문의·차트가 없고(응답이 작다), 상태는 합쳐서 붙인다", async () => {
    const data = await loadSample();
    const cards = cardsOf(analyze(data.inquiries, ALL));
    assert(cards.length > 0);
    for (const c of cards) assert(!("evidence" in c) && !("charts" in c) && !("reason" in c));
    const page = listPage(cards, { [cards[0].id]: [{ status: "조치 중", at: "2026-11-09T00:00:00.000Z" }] }, { pageSize: 3 });
    eq(page.alerts.length, 3);
    eq(page.total, cards.length);
    eq(page.alerts[0].currentStatus, "조치 중");
    eq(page.alerts[1].currentStatus, CONFIG.STATUSES[0]);
  });
  it("상태 필터와 페이지: 거른 뒤에 자른다", async () => {
    const data = await loadSample();
    const cards = cardsOf(analyze(data.inquiries, ALL));
    const map = { [cards[2].id]: [{ status: "해결", at: "2026-11-09T00:00:00.000Z" }] };
    const solved = listPage(cards, map, { status: "해결" });
    eq(solved.total, 1);
    eq(solved.alerts[0].id, cards[2].id);
    eq(listPage(cards, map, { pageSize: 5, page: 999 }).page, listPage(cards, map, { pageSize: 5 }).totalPages, "범위를 넘은 페이지는 마지막 페이지로 보정");
  });
  it("미해결 신호 수: 상태 필터와 무관하게 센다 ('해결'이 아닌 신호). 해결로 바꾸면 줄어든다", async () => {
    const data = await loadSample();
    const cards = cardsOf(analyze(data.inquiries, ALL));
    const none = listPage(cards, {}, {});
    deepEq(none.counts, { all: cards.length, unresolved: cards.length });
    const solved = { [cards[0].id]: [{ status: "해결", at: "2026-11-09T00:00:00.000Z" }], [cards[1].id]: [{ status: "조치 중", at: "2026-11-09T00:00:00.000Z" }] };
    deepEq(listPage(cards, solved, {}).counts, { all: cards.length, unresolved: cards.length - 1 }, "해결 1개만 빠진다 (조치 중은 미해결)");
    deepEq(listPage(cards, solved, { status: "해결" }).counts, { all: cards.length, unresolved: cards.length - 1 }, "상태 필터를 걸어도 같은 숫자");
    eq(listPage(cards, solved, { status: "해결" }).total, 1);
    const again = [{ status: "해결", at: "a" }, { status: "분석 중", at: "b" }];
    eq(listPage(cards, { [cards[0].id]: again }, {}).counts.unresolved, cards.length, "해결 뒤에 다시 열면(마지막 상태가 해결이 아니면) 미해결로 돌아온다");
  });
  it("상세: 이유·차트·근거 한 페이지만 담고, 없는 ID는 null", async () => {
    const data = await loadSample();
    const analysis = analyze(data.inquiries, ALL);
    const target = analysis.alerts.find((a) => a.evidence.length > CONFIG.PAGE_SIZE) ?? analysis.alerts[0];
    const first = detailOf(analysis, target.id, 1);
    eq(first.evidence.items.length, Math.min(CONFIG.PAGE_SIZE, target.evidence.length));
    eq(first.evidence.total, target.evidence.length);
    assert(first.alert.reason && first.alert.charts.length >= 1 && Array.isArray(first.alert.phrases));
    if (target.evidence.length > CONFIG.PAGE_SIZE) assert(detailOf(analysis, target.id, 2).evidence.items[0].id !== first.evidence.items[0].id, "다음 페이지는 다른 문의");
    eq(detailOf(analysis, "없는:id", 1), null);
  });
  it("조건(유형)을 걸면 그 유형으로 좁힌 결과를 돌려준다", async () => {
    const data = await loadSample();
    const filters = normalizeFilters({ category: "배송" });
    const analysis = analyze(data.inquiries, filters);
    eq(overviewOf(analysis).topCategory, "배송");
    assert(analysis.alerts.every((a) => a.type === "repeat" || a.category === "배송"));
  });
});

describe("API 클라이언트 (service-api.js)", () => {
  const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  it("toQuery: '전체'와 빈 값은 보내지 않는다", () => {
    eq(toQuery({ query: "", period: "all", category: "배송" }, { page: 2, status: "all", pageSize: undefined }), "category=%EB%B0%B0%EC%86%A1&page=2");
  });
  it("주소를 만들고 { body, ms }를 돌려준다 (ID는 주소 안전하게 인코딩)", async () => {
    const urls = [];
    const api = createServiceApi("api/v1", async (url) => (urls.push(url), { ok: true, status: 200, json: async () => ({ ok: 1 }) }));
    const r = await api.detail("category:배송:2026-11-09T09", { category: "배송" }, 2);
    deepEq(r.body, { ok: 1 });
    assert(Number.isInteger(r.ms) && r.ms >= 0);
    await api.alerts({ period: "7d" }, { status: "해결", page: 1, pageSize: 200 });
    await api.overview({});
    await api.history("a:b");
    eq(urls[0], "api/v1/alerts/category%3A%EB%B0%B0%EC%86%A1%3A2026-11-09T09?category=%EB%B0%B0%EC%86%A1&evidencePage=2");
    eq(urls[1], "api/v1/alerts?period=7d&status=%ED%95%B4%EA%B2%B0&page=1&pageSize=200");
    eq(urls[2], "api/v1/overview?");
    eq(urls[3], "api/v1/alerts/a%3Ab/status-history");
  });
  it("연결 실패·HTTP 오류·JSON 아님을 사람이 읽을 수 있는 ApiError로", async () => {
    const msgs = [];
    for (const fake of [async () => { throw new TypeError("Failed to fetch"); }, reply(400, { error: "period가 올바르지 않습니다" }), async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })]) {
      try { await createServiceApi("api/v1", fake).overview({}); msgs.push("성공?!"); } catch (e) { assert(e instanceof ApiError); msgs.push(e.message + "|" + e.status); }
    }
    assert(/연결하지 못했습니다.*\|0$/.test(msgs[0]));
    assert(/HTTP 400/.test(msgs[1]) && /period/.test(msgs[1]));
    assert(/JSON/.test(msgs[2]));
  });
  it("상태 저장: 201이면 { status, at }, 요청 거절은 not_saved, 서버 오류·연결 끊김은 unknown", async () => {
    eq((await createServiceApi("api/v1", reply(201, { alertId: "x", status: "분석 중", at: "2026-11-09T00:00:00.000Z" })).saveStatus("x", "분석 중")).status, "분석 중");
    const outcomes = [];
    for (const fake of [reply(400, { error: "알 수 없는 상태" }), reply(409, { error: "충돌", outcome: "not_saved" }), reply(502, { error: "?", outcome: "unknown" }), reply(500, null), async () => { throw new TypeError("x"); }]) {
      try { await createServiceApi("api/v1", fake).saveStatus("x", "분석 중"); outcomes.push("성공?!"); } catch (e) { assert(e instanceof SaveError); outcomes.push(e.outcome); }
    }
    deepEq(outcomes, ["not_saved", "not_saved", "unknown", "unknown", "unknown"]);
  });
});

// ---------------------------------------------------------------- 통합 모드 화면
const sandbox = document.createElement("div");
sandbox.style.cssText = "position:fixed;left:-9999px;top:0;width:1100px";
document.body.appendChild(sandbox);
const settle = async () => { for (let i = 0; i < 8; i++) await tick(0); };
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

/** 서비스를 흉내 낸 api: 같은 query.js로 응답을 만들고, 호출을 기록한다 */
function fakeService(data, { statuses = {}, save } = {}) {
  const calls = { overview: [], alerts: [], detail: [], history: [], save: [] };
  const map = { ...statuses };
  // gate.closed가 되면 조회가 끝나지 않는 것처럼 둔다: 시험이 끝난 뒤에도 자동 갱신 타이머는 남으므로(화면을 닫는 방법이 없다) 무거운 계산을 멈추려고
  const gate = { closed: false };
  const guard = (fn) => (...args) => (gate.closed ? new Promise(() => {}) : fn(...args));
  const api = {
    overview: guard(async (f) => (calls.overview.push(f), { body: { meta: { generated: true }, ...overviewOf(analyze(data.inquiries, normalizeFilters(f))), dataSource: "dbms" }, ms: 12 })),
    alerts: guard(async (f, opts) => (calls.alerts.push({ f, opts }), { body: { ...listPage(cardsOf(analyze(data.inquiries, normalizeFilters(f))), map, opts), dataSource: calls.alerts.length > 1 ? "redis" : "dbms" }, ms: 5 })),
    detail: guard(async (id, f, page) => (calls.detail.push({ id, f, page }), { body: detailOf(analyze(data.inquiries, normalizeFilters(f)), id, page), ms: 3 })),
    history: guard(async (id) => (calls.history.push(id), { body: { history: map[id] ?? [] }, ms: 2 })),
    saveStatus: async (id, status) => {
      calls.save.push([id, status]);
      if (save) return save(id, status, map);
      const at = "2026-11-17T00:00:00.000Z";
      (map[id] ??= []).push({ status, at });
      return { status, at };
    },
  };
  return { api, calls, map, gate };
}

async function withRemote(fn, { statuses, save, refreshMs, dataset } = {}) {
  const data = dataset ?? (await loadSample());
  const box = document.createElement("div");
  sandbox.appendChild(box);
  let service;
  try {
    service = fakeService(data, { statuses, save });
    const c = mountApp(box, { api: service.api, refreshMs });
    await settle();
    await fn({ box, data, ...service, $: (s) => box.querySelector(s), $$: (s) => [...box.querySelectorAll(s)] });
  } finally {
    if (service) service.gate.closed = true;
    box.remove();
  }
}

describe("샘플 모드(브라우저 계산)의 미해결 신호 수", () => {
  it("통합 모드와 같은 규칙: 상태를 해결로 바꾸면 줄고, 다른 상태로 바꾸면 다시 는다", async () => {
    const data = await loadSample();
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      mountApp(box, { load: () => Promise.resolve(data) });
      await settle();
      const total = detectAlerts(data.inquiries, hourRange(data.inquiries)).length;
      const countsText = () => text(box.querySelector(".summary-open"));
      eq(countsText(), `미해결 신호 ${total}개 (전체 ${total}개)`);
      const press = (label) => [...box.querySelectorAll(".status-steps button")].find((b) => b.textContent === label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      press("해결");
      await settle();
      eq(countsText(), `미해결 신호 ${total - 1}개 (전체 ${total}개)`);
      press("조치 중");
      await settle();
      eq(countsText(), `미해결 신호 ${total}개 (전체 ${total}개)`);
    } finally {
      box.remove();
    }
  });
});

describe("통합 모드 화면 (App의 api prop, S4-04 · S4-14)", () => {
  it("서버가 계산한 결과로 요약·신호 카드·상세·근거를 그리고, 문의 전체는 받지 않는다", async () => {
    await withRemote(({ $, $$, data, calls }) => {
      const expected = detectAlerts(data.inquiries, hourRange(data.inquiries)).length;
      eq($$(".alert-card").length, expected);
      assert(text($(".summary")).includes(`${data.inquiries.length.toLocaleString("ko-KR")}건`));
      assert($(".reason p").textContent.length > 10, "첫 신호의 이유");
      assert($$(".inquiry").length >= 1, "근거 문의 한 페이지");
      eq(calls.overview.length, 1);
      eq(calls.alerts[0].opts.pageSize, 200);
    });
  });
  it("요약에 '미해결 신호 N개 (전체 M개)'를 보여 주고, 상태를 해결로 바꾸면 줄어든다 (문의 건수는 그대로)", async () => {
    await withRemote(async ({ $, $$, data }) => {
      const total = detectAlerts(data.inquiries, hourRange(data.inquiries)).length;
      const countsText = () => text($(".summary-open"));
      eq(countsText(), `미해결 신호 ${total}개 (전체 ${total}개)`);
      const summaryBefore = text($(".summary-item"));
      $$(".status-steps button").find((b) => b.textContent === "해결").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      eq(countsText(), `미해결 신호 ${total - 1}개 (전체 ${total}개)`);
      eq(text($(".summary-item")), summaryBefore, "문의 건수는 그대로");
      $$(".status-steps button").find((b) => b.textContent === "분석 중").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      eq(countsText(), `미해결 신호 ${total}개 (전체 ${total}개)`, "해결이 아닌 상태로 바꾸면 다시 미해결");
    });
  });
  it("진행 현황 필터를 걸어도 미해결 신호 수는 그대로다", async () => {
    await withRemote(async ({ $ }) => {
      const before = text($(".summary-open"));
      const select = $('select[name="statusFilter"]');
      select.value = "해결";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      eq(text($(".summary-open")), before);
    });
  });
  it("출처 배지는 서버가 알려 준 값(DBMS 직접 / Redis 캐시)과 응답 시간을 보여 준다", async () => {
    await withRemote(({ $ }) => assert(/DBMS 직접 · 5ms/.test(text($(".badge-dbms")))));
  });
  it("필터를 바꾸면 그 조건으로 서버에 다시 요청한다 (페이지는 1로)", async () => {
    await withRemote(async ({ $, calls }) => {
      const select = $('select[name="category"]');
      select.value = "배송";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      const last = calls.alerts.at(-1);
      eq(last.f.category, "배송");
      eq(calls.detail.at(-1).f.category, "배송");
      eq(calls.detail.at(-1).page, 1);
    });
  });
  it("진행 현황 필터는 서버에 status로 보낸다", async () => {
    await withRemote(async ({ $, calls }) => {
      const select = $('select[name="statusFilter"]');
      select.value = "해결";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
      eq(calls.alerts.at(-1).opts.status, "해결");
    });
  });
  it("근거 문의 페이지를 넘기면 그 페이지만 서버에 요청한다", async () => {
    await withRemote(async ({ $$, calls }) => {
      const next = $$(".pager .page").find((b) => b.textContent === "2");
      if (!next) return; // 첫 신호의 근거가 한 페이지뿐이면 해당 없음
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      eq(calls.detail.at(-1).page, 2);
    });
  });
  it("상태를 저장하면 저장이 확인된 뒤에 목록·이력을 서버에서 다시 받아 반영한다", async () => {
    await withRemote(async ({ $, $$, calls }) => {
      const alertsBefore = calls.alerts.length;
      const step = $$(".status-steps button").find((b) => b.textContent === "조치 중");
      step.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      eq(calls.save.length, 1);
      eq(calls.save[0][1], "조치 중");
      assert(calls.alerts.length > alertsBefore, "저장 뒤 목록을 다시 받는다");
      eq($(".status-steps .current").textContent, "조치 중");
      eq($$(".alert-status")[0].textContent, "상태 · 조치 중");
      eq($$(".status-history li:not(.muted)").length, 1);
    });
  });
  it("저장이 실패하면 화면 상태는 그대로이고 이유를 보여 준다 (not_saved / unknown 구분)", async () => {
    for (const [outcome, expected] of [["not_saved", "저장되지 않았습니다"], ["unknown", "저장 여부를 알 수 없습니다"]]) {
      await withRemote(async ({ $, $$, calls }) => {
        const step = $$(".status-steps button").find((b) => b.textContent === "분석 중");
        step.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await settle();
        assert(text($(".progress .notice")).includes(expected), outcome);
        eq($(".status-steps .current").textContent, "확인 필요", "저장 실패 때는 상태가 바뀌지 않는다");
      }, { save: async () => { throw new SaveError("서버 오류", outcome); } });
    }
  });
  it("자동 갱신: refreshMs마다 서버에 다시 요청하고, 헤더에 간격을 알린다", async () => {
    await withRemote(async ({ $, calls }) => {
      const first = calls.overview.length;
      assert(first >= 1);
      await tick(250);
      assert(calls.overview.length >= first + 3, `자동 갱신으로 여러 번 더 요청해야 한다 (${first} → ${calls.overview.length})`);
      assert(calls.alerts.length >= first + 3 && calls.detail.length >= first + 3, "목록과 상세도 함께 다시 받는다");
      assert(text($(".app-header .note")).includes("초마다 자동 갱신"));
    }, { refreshMs: 30 });
  });
  it("자동 갱신을 끄면(refreshMs 없음) 처음 한 번만 요청하고 안내도 없다", async () => {
    await withRemote(async ({ $, calls }) => {
      const first = calls.overview.length;
      await tick(150);
      eq(calls.overview.length, first);
      assert(!text($(".app-header")).includes("자동 갱신"));
    });
  });
  it("새로 접수된 문의가 다음 갱신 때 건수와 신호에 반영된다 (고객 쪽이 DB에 넣으면 화면이 따라간다)", async () => {
    const base = await loadSample();
    const grown = { inquiries: [...base.inquiries] }; // 서버가 읽는 문의. 아래에서 새 문의를 넣는다
    await withRemote(async ({ $ }) => {
      const before = text($(".summary-item"));
      assert(before.includes(`${base.inquiries.length.toLocaleString("ko-KR")}건`));
      grown.inquiries.push({ id: 999999, created_at: "2026-11-09T23:30:00.000Z", category: "배송", device: "iOS", app_version: "4.4.0", text: "방금 접수된 새 문의입니다." });
      await tick(250);
      assert(text($(".summary-item")).includes(`${(base.inquiries.length + 1).toLocaleString("ko-KR")}건`), "새 문의 1건이 건수에 반영된다");
    }, { refreshMs: 30, dataset: grown });
  });
  it("서버 오류는 모든 데이터 영역에 원인과 함께 표시된다", async () => {
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      mountApp(box, { api: { overview: async () => { throw new ApiError("데이터를 불러오지 못했습니다. (HTTP 503) DBMS 서버에 연결할 수 없습니다.", 503); }, alerts: async () => { throw new ApiError("x", 503); } } });
      await settle();
      for (const area of [".summary", ".signal-list", ".signal-detail"]) assert(box.querySelector(`${area} .status-error`) || text(box.querySelector(area)).includes("DBMS 서버에 연결할 수 없습니다"), area);
    } finally {
      box.remove();
    }
  });
});
