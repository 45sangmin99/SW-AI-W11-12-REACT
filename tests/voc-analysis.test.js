// 고객 문의(VOC) 이상 탐지 로직 단위 테스트 (순수 함수): 시간·필터·요약·4신호 탐지·정규화·페이지·데이터 불러오기·샘플 정답지
import { describe, it, assert, eq, deepEq, throws } from "./runner.js";
import {
  hourOf, eachHour, hourRange, formatHour, formatRange, filterInquiries, sinceHour, inPeriod, summarize,
  normalizePhrase, highlightSegments, detectAlerts,
} from "../src/voc/analysis.js";
import { paginate, pageWindow } from "../src/voc/pagination.js";
import { parseDataset, loadDataset, appVersionsOf } from "../src/voc/data.js";
import { CONFIG } from "../src/voc/config.js";

// ---- 도우미
let seq = 0;
/** 2026-11-01 00시를 기준으로 dayOffset일 hour시 */
const hr = (dayOffset, hour) => new Date(Date.UTC(2026, 10, 1 + dayOffset, hour)).toISOString().slice(0, 13);
/** 기기·버전이 골고루 섞이도록: iOS / Android / Web(web)이 번갈아 나오고 앱 버전도 번갈아 나온다 (쏠림 신호가 우연히 생기지 않게) */
const mix = (k) => ({ device: ["iOS", "Android", "Web"][k % 3], app_version: k % 3 === 2 ? "web" : k % 2 ? "4.2.0" : "4.3.0" });
/** 문의 한 건. 문장이 서로 달라야 반복 문구로 잡히지 않으므로 기본 문장은 짧은 번호 문장(정규화하면 8자 미만)이다 */
const q = (category, hour, extra = {}) => ({ id: ++seq, category, text: `문의 ${seq}`, app_version: "4.3.0", device: "iOS", created_at: `${hour}:30:00.000Z`, ...extra });
/** 같은 시각에 n건. extra가 함수면 k번째 건에 대한 속성을 돌려준다 */
const many = (n, category, hour, extra = mix) => Array.from({ length: n }, (_, k) => q(category, hour, typeof extra === "function" ? extra(k) : extra));
/** days일 동안 매시간 perHour건씩 (평소 문의) */
const history = (category, days, perHour) => {
  const out = [];
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) out.push(...many(perHour, category, hr(d, h)));
  return out;
};
const run = (inquiries, options = {}) => detectAlerts(inquiries, { ...hourRange(inquiries), ...options });
const ofType = (alerts, type) => alerts.filter((a) => a.type === type);

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/inquiries.sample.json").then((r) => r.json()));

describe("시간 도우미", () => {
  it("hourOf: ISO 문자열의 시(UTC)", () => eq(hourOf("2026-11-09T23:59:59.000Z"), "2026-11-09T23"));
  it("eachHour: 시작과 끝을 포함한 모든 시각", () => {
    deepEq(eachHour("2026-11-01T22", "2026-11-02T01"), ["2026-11-01T22", "2026-11-01T23", "2026-11-02T00", "2026-11-02T01"]);
  });
  it("eachHour: 월·연말과 윤일을 지난다", () => {
    deepEq(eachHour("2026-10-31T23", "2026-11-01T00"), ["2026-10-31T23", "2026-11-01T00"]);
    deepEq(eachHour("2026-12-31T23", "2027-01-01T00"), ["2026-12-31T23", "2027-01-01T00"]);
    eq(eachHour("2028-02-28T00", "2028-03-01T00").length, 49); // 2028-02-29 포함
  });
  it("eachHour: 한 시각짜리, from이 to보다 늦으면 빈 목록", () => {
    deepEq(eachHour("2026-11-09T10", "2026-11-09T10"), ["2026-11-09T10"]);
    deepEq(eachHour("2026-11-09T11", "2026-11-09T10"), []);
  });
  it("hourRange: 첫 시각과 마지막 시각, 비어 있으면 null", () => {
    deepEq(hourRange([q("배송", hr(3, 5)), q("배송", hr(0, 7)), q("배송", hr(2, 1))]), { from: hr(0, 7), to: hr(3, 5) });
    eq(hourRange([]), null);
  });
  it("formatHour · formatRange: 같은 시각 / 같은 날 / 날짜가 다른 경우", () => {
    eq(formatHour("2026-11-09T09"), "2026-11-09 09:00");
    eq(formatRange("2026-11-09T09", "2026-11-09T09"), "2026-11-09 09:00~09:59");
    eq(formatRange("2026-11-09T09", "2026-11-09T12"), "2026-11-09 09:00~12:59");
    eq(formatRange("2026-11-08T22", "2026-11-09T01"), "2026-11-08 22:00 ~ 2026-11-09 01:59");
  });
});

describe("filterInquiries · 기간 · summarize (R-03, F-05)", () => {
  const data = [
    q("배송", hr(0, 1), { text: "배송이 늦어요", device: "iOS", app_version: "4.2.0" }),
    q("쿠폰·할인", hr(0, 2), { text: "쿠폰 안 돼요 ABC", device: "Android", app_version: "4.3.0" }),
    q("쿠폰·할인", hr(0, 3), { text: "쿠폰 문의", device: "Web", app_version: "web" }),
  ];
  it("조건이 없으면 전부", () => eq(filterInquiries(data, {}).length, 3));
  it("검색어: 문의 내용에서 부분 일치, 대소문자·앞뒤 공백 무시", () => {
    eq(filterInquiries(data, { query: "쿠폰" }).length, 2);
    eq(filterInquiries(data, { query: "  abc  " }).length, 1);
    eq(filterInquiries(data, { query: "   " }).length, 3);
    eq(filterInquiries(data, { query: "없는말" }).length, 0);
  });
  it("유형·기기·앱 버전은 정확히 일치", () => {
    eq(filterInquiries(data, { category: "쿠폰·할인" }).length, 2);
    eq(filterInquiries(data, { device: "Android" }).length, 1);
    eq(filterInquiries(data, { appVersion: "4.2.0" }).length, 1);
  });
  it("여러 조건은 모두 만족해야 한다", () => {
    eq(filterInquiries(data, { query: "쿠폰", device: "Web" }).length, 1);
    eq(filterInquiries(data, { query: "쿠폰", device: "iOS" }).length, 0);
  });
  it("빈 목록도 안전", () => deepEq(filterInquiries([], { query: "a", category: "배송" }), []));

  it("sinceHour: 기준 시각을 포함해 최근 N시간의 시작 시각", () => {
    eq(sinceHour("24h", "2026-11-09T23"), "2026-11-09T00");
    eq(sinceHour("3d", "2026-11-09T23"), "2026-11-07T00");
    eq(sinceHour("7d", "2026-11-09T23"), "2026-11-03T00");
  });
  it("sinceHour: 전체·알 수 없는 값·기준 없음이면 null", () => {
    eq(sinceHour("all", "2026-11-09T23"), null);
    eq(sinceHour("999h", "2026-11-09T23"), null);
    eq(sinceHour("24h", null), null);
  });
  it("inPeriod: 경계 시각은 포함, null이면 항상 포함", () => {
    assert(inPeriod("2026-11-09T00:00:00.000Z", "2026-11-09T00"));
    assert(!inPeriod("2026-11-08T23:59:59.000Z", "2026-11-09T00"));
    assert(inPeriod("2000-01-01T00:00:00.000Z", null));
  });
  it("summarize: 문의 수와 최다 유형, 동률이면 유형 목록에서 앞선 것", () => {
    deepEq(summarize(data), { count: 3, topCategory: "쿠폰·할인", topCount: 2 });
    eq(summarize([q("배송", hr(0, 1)), q("쿠폰·할인", hr(0, 1))]).topCategory, "쿠폰·할인"); // 쿠폰이 목록에서 먼저
  });
  it("summarize: 비어 있으면 최다 유형 없음", () => deepEq(summarize([]), { count: 0, topCategory: null, topCount: 0 }));
});

describe("문의 급증 (C9, 승인된 설계: 유형별, 같은 시각 과거 평균과 비교)", () => {
  // 기타 유형 1건/시간은 "데이터 범위"를 며칠로 만들기 위한 바닥 데이터다. 범위가 하루 안이면 과거 이력이 없어 급증을 판단할 수 없다
  const spike = (n, { perHour = 3, days = 5, category = "쿠폰·할인", day = days, hour = 10 } = {}) => [
    ...history("기타", days, 1),
    ...history(category, days, perHour),
    ...many(n, category, hr(day, hour)),
  ];

  it("평소 3건인 시간에 25건이 오면 감지한다 (배수 8.3)", () => {
    const alerts = ofType(run(spike(25)), "surge");
    eq(alerts.length, 1);
    eq(alerts[0].category, "쿠폰·할인");
    eq(alerts[0].startHour, hr(5, 10));
    eq(alerts[0].endHour, hr(5, 10));
    eq(alerts[0].evidence.length, 25);
    assert(Math.abs(alerts[0].score - 25 / 3) < 1e-9);
    eq(alerts[0].severity, "medium");
  });
  it("20건 경계: 20건은 감지, 19건은 배수가 아무리 높아도 감지하지 않는다", () => {
    eq(ofType(run(spike(20, { perHour: 0 })), "surge").length, 1);
    eq(ofType(run(spike(19, { perHour: 0 })), "surge").length, 0);
  });
  it("3배 경계: 평균 7건일 때 20건은 아니고(3배=21) 21건은 감지", () => {
    eq(ofType(run(spike(20, { perHour: 7 })), "surge").length, 0);
    eq(ofType(run(spike(21, { perHour: 7 })), "surge").length, 1);
  });
  it("같은 시간대끼리 비교한다: 원래 많은 시간대의 25건은 급증이 아니고, 한가한 시간대의 25건은 급증", () => {
    const busy = [];
    for (let d = 0; d < 5; d++) {
      for (let h = 0; h < 24; h++) busy.push(...many(h === 10 ? 12 : 1, "배송", hr(d, h)));
    }
    eq(ofType(run([...busy, ...many(25, "배송", hr(5, 10))]), "surge").length, 0); // 25 < 3 × 12
    eq(ofType(run([...busy, ...many(25, "배송", hr(5, 14))]), "surge").length, 1); // 25 ≥ 3 × 1
  });
  it("과거 이력이 3일 미만이면 평소를 알 수 없어 판단하지 않는다", () => {
    const filler = (days) => history("기타", days, 1);
    eq(ofType(run([...filler(3), ...many(30, "배송", hr(2, 10))]), "surge").length, 0); // 같은 시각의 과거가 2일치
    eq(ofType(run([...filler(4), ...many(30, "배송", hr(3, 10))]), "surge").length, 1); // 3일치
  });
  it("평균이 0건이어도 20건 이상이면 감지하고 배수는 평균을 1건으로 보고 계산한다", () => {
    const alerts = ofType(run([...history("기타", 4, 1), ...many(30, "배송", hr(4, 10))]), "surge");
    eq(alerts.length, 1);
    eq(alerts[0].score, 30);
    eq(alerts[0].severity, "high");
  });
  it("심각도 경계: 배수 3~5 낮음 / 5~10 중간 / 10 이상 높음", () => {
    const sev = (n, perHour) => ofType(run(spike(n, { perHour })), "surge")[0]?.severity;
    eq(sev(20, 6), "low"); // 3.33배
    eq(sev(20, 4), "medium"); // 5.0배
    eq(sev(39, 4), "medium"); // 9.75배
    eq(sev(40, 4), "high"); // 10.0배
  });
  it("연속된 시각은 하나의 발생 건으로 합치고, 떨어져 있으면 따로 센다", () => {
    const base = history("쿠폰·할인", 5, 3);
    const joined = ofType(run([...base, ...many(25, "쿠폰·할인", hr(5, 10)), ...many(25, "쿠폰·할인", hr(5, 11)), ...many(25, "쿠폰·할인", hr(5, 12))]), "surge");
    eq(joined.length, 1);
    eq(joined[0].startHour, hr(5, 10));
    eq(joined[0].endHour, hr(5, 12));
    eq(joined[0].id, `surge:쿠폰·할인:${hr(5, 10)}`);
    const apart = ofType(run([...base, ...many(25, "쿠폰·할인", hr(5, 10)), ...many(25, "쿠폰·할인", hr(5, 12))]), "surge");
    eq(apart.length, 2);
  });
  it("유형별로 따로 판정한다: 다른 유형의 급증이 섞이지 않는다", () => {
    const data = [...history("쿠폰·할인", 5, 3), ...history("배송", 5, 3), ...many(25, "배송", hr(5, 10))];
    deepEq(ofType(run(data), "surge").map((a) => a.category), ["배송"]);
  });
  it("차트는 발생 구간 앞뒤를 포함한 시간별 막대이고 발생한 시각이 강조된다", () => {
    const [alert] = ofType(run(spike(25)), "surge");
    const bars = alert.charts[0].bars;
    // 발생 시각이 데이터의 마지막 시각이라 뒤쪽 여유는 없고, 앞쪽으로 CHART_PAD_BEFORE시간 + 발생 시각 1개
    eq(bars.length, CONFIG.CHART_PAD_BEFORE + 1);
    eq(bars.filter((b) => b.highlight).length, 1);
    eq(bars.find((b) => b.highlight).value, 25);
    assert(bars.every((b) => typeof b.label === "string" && typeof b.short === "string"));
  });
  it("데이터 범위 끝에서는 뒤쪽 여유 시간이 없어도 안전하다", () => {
    const [alert] = ofType(run(spike(25, { hour: 23 })), "surge");
    assert(alert);
    eq(alert.charts[0].bars.at(-1).highlight, true);
  });
});

describe("유형 쏠림 (C9: 평소보다 20%p 이상, 그 시간 문의 20건 이상)", () => {
  // 평소: 쿠폰 5건 + 배송 5건 (각 50%)
  const usual = [...history("쿠폰·할인", 5, 5), ...history("배송", 5, 5)];
  const hour = hr(5, 10);
  const spikeOf = (coupon, delivery) => [...usual, ...many(coupon, "쿠폰·할인", hour), ...many(delivery, "배송", hour)];

  it("배송이 80%가 되어 평소(50%)보다 30%p 높으면 감지하고 심각도는 중간", () => {
    const alerts = ofType(run(spikeOf(5, 20)), "category");
    deepEq(alerts.map((a) => a.category), ["배송"]);
    eq(alerts[0].severity, "medium");
    eq(alerts[0].evidence.length, 20);
    assert(alerts[0].reason.includes("80%") && alerts[0].reason.includes("50%") && alerts[0].reason.includes("30%p"));
  });
  it("20%p 경계: 70%(=+20%p)는 감지, 65%는 아니다", () => {
    deepEq(ofType(run(spikeOf(6, 14)), "category").map((a) => a.category), ["배송"]); // 14/20 = 70%
    eq(ofType(run(spikeOf(7, 13)), "category").length, 0); // 65%
  });
  it("그 시간 전체 문의가 20건 미만이면 비율이 높아도 판단하지 않는다 (경계 19 / 20)", () => {
    eq(ofType(run(spikeOf(4, 15)), "category").length, 0); // 합계 19
    eq(ofType(run(spikeOf(5, 15)), "category").length, 1); // 합계 20
  });
  it("과거 이력이 3일(72시간) 미만이면 판단하지 않는다", () => {
    const early = [...history("쿠폰·할인", 3, 5), ...history("배송", 3, 5)];
    eq(ofType(run([...early, ...many(5, "쿠폰·할인", hr(2, 10)), ...many(20, "배송", hr(2, 10))]), "category").length, 0);
    eq(ofType(run([...early, ...many(5, "쿠폰·할인", hr(3, 10)), ...many(20, "배송", hr(3, 10))]), "category").length, 1);
  });
  it("심각도: +20~30%p 낮음 / 30~40 중간 / 40 이상 높음", () => {
    const sev = (coupon, delivery) => ofType(run(spikeOf(coupon, delivery)), "category")[0]?.severity;
    eq(sev(6, 14), "low"); // +20
    eq(sev(5, 20), "medium"); // +30
    eq(sev(1, 24), "high"); // +46
  });
  it("skipCategory: 유형 필터가 켜져 있으면 유형 쏠림은 계산하지 않는다", () => {
    eq(ofType(run(spikeOf(5, 20), { skipCategory: true }), "category").length, 0);
  });
  it("차트는 발생 구간의 유형별 분포이고 쏠린 유형이 강조된다 (C5)", () => {
    const [alert] = ofType(run(spikeOf(5, 20)), "category");
    const bars = alert.charts[0].bars;
    deepEq(bars.map((b) => b.label), CONFIG.CATEGORIES);
    eq(bars.find((b) => b.label === "배송").value, 20);
    deepEq(bars.filter((b) => b.highlight).map((b) => b.label), ["배송"]);
  });
});

describe("기기·버전 쏠림 (C9: 한 기기 또는 앱 버전 70% 이상, 20건 이상)", () => {
  const hour = hr(5, 10);
  const login = (n, pick) => many(n, "로그인·계정", hour, pick);
  const envAlerts = (list, options) => ofType(run([...history("기타", 4, 1), ...list], options), "env");

  it("Android가 70% 이상이면 감지하고, 기기별·앱 버전별 두 차트를 만든다 (C5)", () => {
    const [alert] = envAlerts(login(25, (k) => (k < 20 ? { device: "Android", app_version: "4.4.0" } : mix(k))));
    assert(alert);
    eq(alert.category, "로그인·계정");
    eq(alert.charts.length, 2);
    deepEq(alert.charts[0].bars.map((b) => b.label), CONFIG.DEVICES);
    deepEq(alert.charts[0].bars.filter((b) => b.highlight).map((b) => b.label), ["Android"]);
    assert(alert.charts[1].bars.some((b) => b.label === "4.4.0" && b.highlight));
    assert(alert.reason.includes("Android") && alert.reason.includes("4.4.0"));
  });
  it("70% 경계: 14/20은 감지, 13/20은 아니다", () => {
    const only = (androidCount) => (k) => (k < androidCount ? { device: "Android", app_version: ["4.2.0", "4.3.0", "4.4.0"][k % 3] } : { device: k % 2 ? "iOS" : "Web", app_version: k % 2 ? ["4.2.0", "4.3.0", "4.4.0"][k % 3] : "web" });
    eq(envAlerts(login(20, only(14))).length, 1);
    eq(envAlerts(login(20, only(13))).length, 0);
  });
  it("20건 경계: 19건이 전부 Android여도 판단하지 않는다", () => {
    eq(envAlerts(login(19, { device: "Android", app_version: "4.4.0" })).length, 0);
    eq(envAlerts(login(20, { device: "Android", app_version: "4.4.0" })).length, 1);
  });
  it("기기는 골고루인데 앱 버전만 쏠려도 감지한다", () => {
    const [alert] = envAlerts(login(25, (k) => ({ device: ["iOS", "Android", "Web"][k % 3], app_version: k < 20 ? "4.4.0" : "4.2.0" })));
    assert(alert);
    const finding = alert.reason.split("(기준")[0]; // 뒤의 기준 설명에는 "기기"라는 말이 원래 들어 있다
    assert(finding.includes("앱 4.4.0 버전"));
    assert(!finding.includes("기기"));
  });
  it("Web 기기의 'web'은 앱 버전 후보에서 제외된다 (Web이 쏠리면 기기로만 잡힌다)", () => {
    const [alert] = envAlerts(login(25, { device: "Web", app_version: "web" }));
    assert(alert);
    assert(alert.reason.includes("Web 기기"));
    assert(!alert.reason.includes("앱 web"));
    deepEq(alert.charts[1].bars.map((b) => b.label), []);
  });
  it("skipDevice·skipVersion: 해당 필터가 켜져 있으면 그 항목은 판단하지 않는다", () => {
    const deviceOnly = login(25, (k) => ({ device: k < 20 ? "Android" : "iOS", app_version: ["4.2.0", "4.3.0", "4.4.0"][k % 3] }));
    eq(envAlerts(deviceOnly).length, 1);
    eq(envAlerts(deviceOnly, { skipDevice: true }).length, 0);
    const versionOnly = login(25, (k) => ({ device: ["iOS", "Android", "Web"][k % 3], app_version: k < 20 ? "4.4.0" : "4.2.0" }));
    eq(envAlerts(versionOnly, { skipVersion: true }).length, 0);
  });
  it("심각도: 70~80% 낮음 / 80~90 중간 / 90 이상 높음", () => {
    const sev = (androidCount) =>
      envAlerts(login(20, (k) => (k < androidCount ? { device: "Android", app_version: ["4.2.0", "4.3.0", "4.4.0"][k % 3] } : { device: "iOS", app_version: ["4.2.0", "4.3.0", "4.4.0"][k % 3] })))[0]?.severity;
    eq(sev(14), "low");
    eq(sev(16), "medium"); // 80%
    eq(sev(18), "high"); // 90%
  });
  it("유형별로 판정한다: 두 유형이 섞여도 각자의 구간만 본다", () => {
    const mixed = [...many(15, "로그인·계정", hour, { device: "Android", app_version: "4.4.0" }), ...many(15, "배송", hour, mix)];
    eq(envAlerts(mixed).length, 0); // 유형별로는 각각 15건이라 20건 미만
  });
});

describe("반복 문구 (C9: 같은 문구가 1시간 안에 10건 이상, 문장 단위 + 숫자 마스킹)", () => {
  const phrase = "쿠폰이 적용됐다고 나오는데 결제 금액이 그대로예요";
  const same = (n, hour, text = phrase) => Array.from({ length: n }, (_, k) => q("쿠폰·할인", hour, { text: typeof text === "function" ? text(k) : text, ...mix(k) }));
  const repeats = (list) => ofType(run([...history("기타", 4, 1), ...list]), "repeat");

  it("같은 문장이 10건이면 감지, 9건이면 감지하지 않는다 (경계)", () => {
    eq(repeats(same(10, hr(5, 10))).length, 1);
    eq(repeats(same(9, hr(5, 10))).length, 0);
  });
  it("한 시간 안이어야 한다: 6건씩 두 시간에 나뉘면 합쳐서 세지 않는다", () => {
    eq(repeats([...same(6, hr(5, 10)), ...same(6, hr(5, 11))]).length, 0);
  });
  it("숫자는 #으로 가려서 같은 문구로 본다: 주문번호가 문장 안에 있어 문의마다 달라도 반복으로 잡힌다", () => {
    const withOrder = (k) => `주문번호 ${100000 + k * 7919} ${phrase}`; // 같은 문장인데 숫자만 다르다
    const alerts = repeats(same(12, hr(5, 10), withOrder));
    eq(alerts.length, 1);
    eq(alerts[0].evidence.length, 12);
    assert(alerts[0].phrases[0].key.startsWith("주문번호 # 쿠폰이"), alerts[0].phrases[0].key);
    assert(alerts[0].phrase.startsWith("주문번호 # 쿠폰이"), "화면에는 숫자를 #으로 가려서 보여준다");
    assert(alerts[0].evidence.every((e) => /\d{6}/.test(e.text)), "근거 문의 원문에는 실제 주문번호가 그대로 있다");
  });
  it("숫자만 다른 문장 10건은 숫자를 가리지 않으면 흩어져서 놓친다 (가려야 10건으로 합쳐진다)", () => {
    // 번호가 100000~100008, 그리고 100000이 한 번 더: 가리지 않으면 같은 문장은 최대 2건뿐이다
    const texts = (k) => `주문번호 ${k < 9 ? 100000 + k : 100000} ${phrase}`;
    eq(repeats(same(10, hr(5, 10), texts)).length, 1);
  });
  it("문장 단위로 비교한다: 다른 문장이 붙어 있어도 반복 문장은 잡힌다", () => {
    // 앞 문장은 문의마다 다르고(서로 다른 10문장), 뒤 문장만 모두 같다
    const firsts = ["아침에 주문했는데요", "어제 결제했습니다", "지난주에 샀어요", "오늘 아침에 받았어요", "방금 확인해봤어요", "친구 선물로 샀는데", "재구매한 상품입니다", "처음 이용해봅니다", "오래 기다렸는데요", "급하게 필요해서요"];
    const alerts = repeats(same(10, hr(5, 10), (k) => `${firsts[k]}. ${phrase}`));
    eq(alerts.length, 1);
    assert(alerts[0].phrases[0].key.includes("결제 금액이 그대로예요"));
  });
  it("대소문자·구두점·공백이 달라도 같은 문구", () => {
    const variants = ["Login ERROR happens again!!", "login error   happens again", "LOGIN ERROR, happens again.", "Login error happens again?"];
    eq(repeats(same(12, hr(5, 10), (k) => variants[k % 4])).length, 1);
  });
  it("한 문의 안에서 같은 문장을 여러 번 써도 1건으로 센다", () => {
    eq(repeats(same(9, hr(5, 10), `${phrase}. ${phrase}. ${phrase}`)).length, 0);
  });
  it("짧은 문구('감사합니다')는 아무리 반복돼도 이상으로 보지 않는다", () => {
    eq(repeats(same(40, hr(5, 10), "감사합니다")).length, 0);
  });
  it("심각도: 한 시간 10~19건 낮음 / 20~39 중간 / 40건 이상 높음", () => {
    const sev = (n) => repeats(same(n, hr(5, 10)))[0]?.severity;
    eq(sev(10), "low");
    eq(sev(19), "low");
    eq(sev(20), "medium");
    eq(sev(39), "medium");
    eq(sev(40), "high");
  });
  it("연속된 시각은 하나로 합치고, 근거 문의는 그 문구가 들어간 문의만이다", () => {
    const alerts = repeats([...same(10, hr(5, 10)), ...same(11, hr(5, 11)), ...many(5, "배송", hr(5, 10))]);
    eq(alerts.length, 1);
    eq(alerts[0].startHour, hr(5, 10));
    eq(alerts[0].endHour, hr(5, 11));
    eq(alerts[0].evidence.length, 21);
    assert(alerts[0].evidence.every((e) => e.text === phrase));
  });
  it("차트는 시간별 반복 발생 수이고, 반복이 있던 시각이 강조된다 (C5)", () => {
    const [alert] = repeats(same(12, hr(5, 10)));
    const bars = alert.charts[0].bars;
    eq(bars.filter((b) => b.highlight).length, 1);
    eq(bars.find((b) => b.highlight).value, 12);
  });
  it("서로 다른 반복 문구는 각각의 발생 건이다", () => {
    const other = "반품비가 왜 나왔어요 안내에 없던 금액이에요";
    eq(repeats([...same(10, hr(5, 10)), ...same(10, hr(5, 10), other)]).length, 2);
  });
});

describe("발생 건 목록: 정렬 · 빈 입력 · 범위", () => {
  it("심각도 높은 순으로, 같은 심각도면 최근 구간이 먼저", () => {
    const phrase = "같은 문구가 계속 들어오고 있습니다";
    const same = (n, hour) => Array.from({ length: n }, (_, k) => q("기타", hour, { text: phrase, ...mix(k) }));
    const data = [...history("배송", 4, 1), ...same(12, hr(4, 3)), ...same(12, hr(4, 9)), ...same(45, hr(4, 5))]; // 낮음(03시) · 낮음(09시) · 높음(05시)
    const repeatAlerts = ofType(run(data), "repeat");
    // 같은 문구 키라 시각이 떨어져 있으면 별개의 발생 건. 12건은 낮음, 45건은 높음
    deepEq(repeatAlerts.map((a) => a.severity), ["high", "low", "low"]);
    assert(repeatAlerts[1].endHour > repeatAlerts[2].endHour, "같은 심각도에서는 최근 구간이 먼저");
  });
  it("범위가 없거나 문의가 없으면 빈 목록", () => {
    deepEq(detectAlerts([], {}), []);
    deepEq(detectAlerts([q("배송", hr(0, 1))], {}), []);
    deepEq(detectAlerts([], { from: hr(0, 0), to: hr(1, 0) }), []);
  });
  it("범위 밖 문의와 알 수 없는 유형의 문의는 무시한다", () => {
    const clean = [...history("쿠폰·할인", 5, 3), ...many(25, "쿠폰·할인", hr(5, 10))];
    const noisy = [...clean, ...many(40, "없는유형", hr(5, 10)), ...many(40, "쿠폰·할인", hr(30, 10))];
    const range = hourRange(clean);
    const ids = (list) => detectAlerts(list, range).map((a) => a.id);
    assert(ids(clean).length > 0);
    deepEq(ids(noisy), ids(clean)); // 범위 밖·알 수 없는 유형은 결과에 영향이 없다
  });
});

describe("정규화 · 강조 (U-14, F-06)", () => {
  it("normalizePhrase: 소문자, 숫자는 #, 기호 제거, 공백 정리", () => {
    eq(normalizePhrase("  Hello,   WORLD!! 주문번호 123456 "), "hello world 주문번호 #");
    eq(normalizePhrase("3일째 배송 안 와요 (1234)"), "#일째 배송 안 와요 #");
    eq(normalizePhrase("..."), "");
  });
  it("조각을 이어 붙이면 원문과 같고, 반복 문장만 mark", () => {
    const text = "배송 빨라요. 쿠폰이 적용됐다고 나오는데 결제 금액이 그대로예요! 주문번호 123456";
    const phrases = [{ key: normalizePhrase("쿠폰이 적용됐다고 나오는데 결제 금액이 그대로예요") }];
    const segments = highlightSegments(text, phrases);
    eq(segments.map((s) => s.text).join(""), text);
    const marked = segments.filter((s) => s.mark);
    eq(marked.length, 1);
    assert(marked[0].text.includes("결제 금액이 그대로예요"));
  });
  it("phrases가 없으면 전체가 mark 아님, 빈 문자열도 안전", () => {
    assert(highlightSegments("안녕하세요. 반갑습니다.").every((s) => !s.mark));
    deepEq(highlightSegments(""), []);
  });
});

describe("샘플 데이터 (data/inquiries.sample.json): 시나리오 6개 정답지 (R-10, 18.1.1)", () => {
  const overlaps = (alert, w) => alert.startHour <= w.end && alert.endHour >= w.start;
  /** 이 발생 건이 그 시나리오로 설명되는가: 시간이 겹치고, 유형이 같다 (반복 문구는 근거 문의가 모두 그 시나리오의 유형) */
  const belongs = (a, s) =>
    s.windows.some((w) => overlaps(a, w)) && (a.category === null ? a.evidence.every((e) => e.category === s.category) : a.category === s.category);
  const sampleAlerts = async () => {
    const { inquiries, meta } = parseDataset(await loadSample());
    return { inquiries, meta, alerts: detectAlerts(inquiries, hourRange(inquiries)) };
  };

  it("정확히 3,000건이고 레코드가 모두 유효하며 생성 데이터·가상 회사로 표시돼 있다", async () => {
    const { inquiries, meta, skipped } = parseDataset(await loadSample());
    eq(inquiries.length, 3000);
    eq(skipped, 0);
    eq(meta.generated, true);
    assert(meta.company.includes("가상"));
    deepEq(inquiries.map((r) => r.id), inquiries.map((_, i) => i + 1)); // id 1..3000, 시간순
    assert(inquiries.every((r) => CONFIG.CATEGORIES.includes(r.category) && CONFIG.DEVICES.includes(r.device)));
  });
  it("시나리오마다 정의서가 말한 주 신호를 시나리오 시간대·유형에서 찾아낸다", async () => {
    const { meta, alerts } = await sampleAlerts();
    for (const s of meta.scenarios) {
      for (const type of s.expect) {
        const hit = alerts.find((a) => a.type === type && belongs(a, s));
        assert(hit, `시나리오 ${s.id}(${s.category}): ${type} 신호를 찾지 못했다`);
      }
    }
  });
  it("모든 발생 건은 시나리오로 설명된다 (시나리오 밖 시간·유형에서 오탐이 없다)", async () => {
    const { meta, alerts } = await sampleAlerts();
    assert(alerts.length > 0);
    for (const a of alerts) {
      assert(meta.scenarios.some((s) => belongs(a, s)), `설명되지 않는 발생 건: ${a.id}`);
    }
  });
  it("네 가지 신호와 세 가지 심각도가 모두 나타난다", async () => {
    const { alerts } = await sampleAlerts();
    deepEq([...new Set(alerts.map((a) => a.type))].sort(), ["category", "env", "repeat", "surge"]);
    deepEq([...new Set(alerts.map((a) => a.severity))].sort(), ["high", "low", "medium"]);
  });
  it("숫자 마스킹 덕분에 주문번호가 다른 반복 문구도 잡힌다 (시나리오 1)", async () => {
    const { alerts } = await sampleAlerts();
    const coupon = alerts.find((a) => a.type === "repeat" && a.phrase.includes("결제 금액이 그대로예요"));
    assert(coupon);
    assert(new Set(coupon.evidence.map((e) => e.text)).size > 20, "주문번호가 서로 다른 문의들이 한 문구로 묶였다");
  });
  it("기간 필터가 이력을 자르지 않는다: 마지막 날만 보아도 평소 대비 급증이 판정된다", async () => {
    const { inquiries } = await sampleAlerts();
    const range = hourRange(inquiries);
    const all = detectAlerts(inquiries, range);
    const since = sinceHour("24h", range.to);
    const lastDay = all.filter((a) => a.endHour >= since);
    assert(lastDay.some((a) => a.type === "surge" && a.category === "로그인·계정"));
  });
});

describe("paginate / pageWindow (F-02)", () => {
  const items = Array.from({ length: 12 }, (_, i) => i + 1);
  it("페이지별로 자르고 마지막 페이지는 나머지만", () => {
    deepEq(paginate(items, 1, 5).items, [1, 2, 3, 4, 5]);
    deepEq(paginate(items, 3, 5).items, [11, 12]);
    eq(paginate(items, 1, 5).totalPages, 3);
  });
  it("범위를 벗어난 페이지는 1~마지막으로 보정, 정수가 아니면 1페이지", () => {
    eq(paginate(items, 0, 5).page, 1);
    eq(paginate(items, -3, 5).page, 1);
    eq(paginate(items, 99, 5).page, 3);
    eq(paginate(items, NaN, 5).page, 1);
    eq(paginate(items, 1.5, 5).page, 1);
    eq(paginate(items, "2", 5).page, 1);
  });
  it("빈 목록: 총 1페이지, 항목 없음", () => {
    const p = paginate([], 5, 5);
    deepEq(p.items, []);
    eq(p.totalPages, 1);
    eq(p.page, 1);
    eq(p.total, 0);
  });
  it("정확히 나누어떨어지는 건수, 잘못된 페이지 크기", () => {
    eq(paginate(Array(10).fill(0), 1, 5).totalPages, 2);
    eq(paginate(items, 1, 0).totalPages, 12);
  });
  it("pageWindow: 적으면 전부, 많으면 …로 줄인다", () => {
    deepEq(pageWindow(1, 1), [1]);
    deepEq(pageWindow(2, 3), [1, 2, 3]);
    deepEq(pageWindow(5, 10), [1, "…", 4, 5, 6, "…", 10]);
    deepEq(pageWindow(1, 10), [1, 2, "…", 10]);
    deepEq(pageWindow(10, 10), [1, "…", 9, 10]);
    deepEq(pageWindow(3, 10), [1, 2, 3, 4, "…", 10]);
  });
});

describe("parseDataset / loadDataset (F-03)", () => {
  const good = { id: 1, category: "배송", text: "t", app_version: "4.3.0", device: "iOS", created_at: "2026-10-01T00:00:00.000Z" };

  it("배열과 { meta, inquiries } 두 형태를 받는다", () => {
    eq(parseDataset([good]).inquiries.length, 1);
    const wrapped = parseDataset({ meta: { generated: true }, inquiries: [good] });
    eq(wrapped.inquiries.length, 1);
    eq(wrapped.meta.generated, true);
  });
  it("형식이 틀린 레코드는 건너뛰고 건수를 알려준다", () => {
    const bad = [
      null, 3, "x", {}, { ...good, id: "1" }, { ...good, id: 1.5 }, { ...good, category: "없는유형" }, { ...good, category: "" },
      { ...good, device: "Windows" }, { ...good, device: "ios" }, { ...good, app_version: "" }, { ...good, app_version: 4 },
      { ...good, text: 1 }, { ...good, created_at: "어제" }, { ...good, created_at: null },
    ];
    const r = parseDataset([good, ...bad]);
    eq(r.inquiries.length, 1);
    eq(r.skipped, bad.length);
  });
  it("배열이 아니면 에러", () => {
    for (const bad of [null, undefined, 5, "x", {}, { inquiries: "x" }]) throws(() => parseDataset(bad), /형식/);
  });
  it("빈 배열은 정상 (빈 상태)", () => deepEq(parseDataset([]).inquiries, []));
  it("loadDataset: 성공", async () => {
    eq((await loadDataset("x", async () => ({ ok: true, json: async () => [good] }))).inquiries.length, 1);
  });
  it("loadDataset: 네트워크 실패·HTTP 오류·JSON 오류·형식 오류를 사람이 읽을 수 있는 메시지로", async () => {
    const msgs = [];
    for (const fake of [
      async () => { throw new TypeError("Failed to fetch"); },
      async () => ({ ok: false, status: 404 }),
      async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } }),
      async () => ({ ok: true, json: async () => ({ nope: 1 }) }),
    ]) {
      try { await loadDataset("x", fake); msgs.push("성공?!"); } catch (e) { msgs.push(e.message); }
    }
    assert(/불러오지 못했습니다/.test(msgs[0]));
    assert(/404/.test(msgs[1]));
    assert(/JSON/.test(msgs[2]));
    assert(/형식/.test(msgs[3]));
  });
  it("appVersionsOf: 중복 없이 정렬하고 'web'은 앱 버전이 아니므로 뺀다", () => {
    deepEq(appVersionsOf([{ app_version: "4.3.0" }, { app_version: "web" }, { app_version: "4.2.0" }, { app_version: "4.3.0" }]), ["4.2.0", "4.3.0"]);
  });
});
