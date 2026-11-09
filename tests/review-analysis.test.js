// 리뷰 이상 탐지 로직 단위 테스트 (순수 함수): 분석·페이지 나누기·입력 검증·데이터 불러오기
import { describe, it, assert, eq, deepEq, throws } from "./runner.js";
import {
  dayOf, eachDay, latestDay, filterReviews, summarize, detectSurge, detectSkew, detectRepeat,
  detectSignals, normalizePhrase, highlightSegments,
} from "../src/review/analysis.js";
import { paginate, pageWindow } from "../src/review/pagination.js";
import { validateReview } from "../src/review/validate.js";
import { parseDataset, loadDataset, nextId, productIds } from "../src/review/data.js";
import { CONFIG } from "../src/review/config.js";

// ---- 도우미
let seq = 0;
const rv = (product_id, rating, text, day, extra = {}) => ({ id: ++seq, product_id, rating, text, created_at: `${day}T12:00:00.000Z`, ...extra });
/** startDay부터 하루씩 counts[i]건씩 만든다 */
function perDay(product, startDay, counts, rating = 4) {
  const days = eachDay(startDay, new Date(Date.parse(`${startDay}T00:00:00Z`) + (counts.length - 1) * 86_400_000).toISOString().slice(0, 10));
  return days.flatMap((day, i) => Array.from({ length: counts[i] }, (_, k) => rv(product, rating, `리뷰 ${day} ${k}`, day)));
}
const flat = (n, value) => Array.from({ length: n }, () => value);

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/reviews.sample.json").then((r) => r.json()));

describe("날짜 도우미", () => {
  it("eachDay: 시작과 끝을 포함한 모든 날짜", () => {
    deepEq(eachDay("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
  it("eachDay: 윤년 2월 29일과 연말·연초를 지난다", () => {
    deepEq(eachDay("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29", "2028-03-01"]);
    deepEq(eachDay("2026-12-31", "2027-01-01"), ["2026-12-31", "2027-01-01"]);
  });
  it("eachDay: 하루짜리", () => {
    deepEq(eachDay("2026-11-09", "2026-11-09"), ["2026-11-09"]);
  });
  it("latestDay: 가장 최근 날짜, 비어 있으면 null", () => {
    eq(latestDay([rv("a", 5, "x", "2026-10-01"), rv("a", 5, "x", "2026-10-09"), rv("a", 5, "x", "2026-10-05")]), "2026-10-09");
    eq(latestDay([]), null);
  });
  it("dayOf: ISO 문자열의 날짜(UTC)", () => {
    eq(dayOf("2026-11-09T23:59:59.000Z"), "2026-11-09");
  });
});

describe("filterReviews (R-03)", () => {
  const data = [
    rv("prod-001", 5, "a", "2026-11-09"),
    rv("prod-002", 1, "b", "2026-11-05"),
    rv("prod-010", 3, "c", "2026-11-03"),
    rv("PROD-003", 4, "d", "2026-10-01"),
  ];
  it("조건이 없으면 전부", () => eq(filterReviews(data, {}).length, 4));
  it("검색어: 부분 일치, 대소문자 무시, 앞뒤 공백 무시", () => {
    deepEq(filterReviews(data, { query: " prod-00 " }).map((r) => r.product_id), ["prod-001", "prod-002", "PROD-003"]);
    deepEq(filterReviews(data, { query: "PROD-010" }).map((r) => r.product_id), ["prod-010"]);
  });
  it("검색어가 공백뿐이면 전체", () => eq(filterReviews(data, { query: "   " }).length, 4));
  it("기간: 기준일 포함 최근 N일 (7일이면 기준일-6일까지)", () => {
    // 기준일 11-09, 7일 → 11-03부터
    deepEq(filterReviews(data, { period: "7" }).map((r) => r.id), [data[0].id, data[1].id, data[2].id]);
    // 6일이었다면 11-04부터이므로 prod-010(11-03)은 빠진다 → 경계는 정확히 11-03
    eq(filterReviews(data, { period: "7" }, "2026-11-09").some((r) => r.product_id === "prod-010"), true);
    eq(filterReviews(data, { period: "7" }, "2026-11-10").some((r) => r.product_id === "prod-010"), false);
  });
  it("기간: 알 수 없는 값이거나 'all'이면 전체", () => {
    eq(filterReviews(data, { period: "all" }).length, 4);
    eq(filterReviews(data, { period: "999" }).length, 4);
  });
  it("평점: 문자열 숫자로 걸러낸다", () => {
    deepEq(filterReviews(data, { rating: "1" }).map((r) => r.product_id), ["prod-002"]);
    eq(filterReviews(data, { rating: "all" }).length, 4);
  });
  it("여러 조건은 모두 만족해야 한다", () => {
    eq(filterReviews(data, { query: "prod-00", period: "7", rating: "5" }).length, 1);
  });
  it("빈 데이터도 안전", () => {
    deepEq(filterReviews([], { query: "a", period: "7", rating: "3" }), []);
  });
});

describe("summarize (F-05)", () => {
  it("평균은 소수 첫째 자리로 반올림", () => {
    deepEq(summarize([{ rating: 5 }, { rating: 4 }, { rating: 4 }]), { count: 3, average: 4.3 });
  });
  it("리뷰가 없으면 평균은 null", () => deepEq(summarize([]), { count: 0, average: null }));
});

describe("detectSurge: 리뷰 급증", () => {
  const quiet = [1, 2, 1, 0, 2, 1, 1, 2, 1, 0, 1, 2, 1, 1, 2, 1, 0, 1, 1, 2]; // 20일, 평소 하루 1건 안팎

  it("평소엔 조용하다가 하루만 크게 튀면 감지하고, 그날의 리뷰가 근거가 된다", () => {
    const counts = [...quiet];
    counts[10] = 25;
    const s = detectSurge(perDay("p", "2026-10-01", counts), "p");
    assert(s, "신호가 있어야 한다");
    eq(s.type, "surge");
    eq(s.evidence.length, 25);
    assert(s.evidence.every((r) => dayOf(r.created_at) === "2026-10-11"));
    eq(s.bars.length, 20);
    eq(s.bars.filter((b) => b.highlight).length, 1);
    eq(s.severity, "medium"); // 20일짜리는 z가 최대 4.25라서 높음(7 이상)이 될 수 없다
  });
  it("심각도: 기간이 길고 하루만 크게 튀면 높음, 살짝 튀면 낮음", () => {
    const long = flat(60, 1);
    long[30] = 40;
    eq(detectSurge(perDay("p", "2026-09-01", long), "p").severity, "high");
    const mild = flat(14, 3);
    mild[6] = 9;
    eq(detectSurge(perDay("p", "2026-10-01", mild), "p").severity, "low");
  });
  it("평평하게 매일 같은 건수면 튀는 날이 없어 null", () => {
    eq(detectSurge(perDay("p", "2026-10-01", flat(20, 3)), "p"), null);
  });
  it("기간이 SURGE_MIN_DAYS보다 짧으면 평소 수준을 알 수 없어 null", () => {
    const counts = flat(CONFIG.SURGE_MIN_DAYS - 1, 1);
    counts[3] = 30;
    eq(detectSurge(perDay("p", "2026-10-01", counts), "p"), null);
  });
  // 기간은 "첫 리뷰 ~ 마지막 리뷰"로 정해지므로, 20일 범위를 만들려고 처음과 끝날에 1건씩 둔다
  // (그러지 않으면 SURGE_MIN_DAYS 규칙 때문에 건수와 상관없이 null이 되어 테스트가 의미가 없다)
  const spikeIn20Days = (spike) => {
    const counts = flat(20, 0);
    counts[0] = 1;
    counts[19] = 1;
    counts[10] = spike;
    return perDay("p", "2026-10-01", counts);
  };
  it("z가 높아도 SURGE_MIN_COUNT건 미만이면 급증으로 보지 않는다", () => {
    const below = spikeIn20Days(CONFIG.SURGE_MIN_COUNT - 1);
    // 평균 + 2σ는 넘지만 건수가 모자란 경우임을 확인
    const counts = Array.from({ length: 20 }, (_, i) => below.filter((r) => dayOf(r.created_at) === eachDay("2026-10-01", "2026-10-20")[i]).length);
    const mean = counts.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / 20);
    assert(CONFIG.SURGE_MIN_COUNT - 1 > mean + CONFIG.SURGE_Z * std, "z 조건은 만족해야 이 테스트가 의미 있다");
    eq(detectSurge(below, "p"), null);
  });
  it("경계: 정확히 SURGE_MIN_COUNT건이면 감지", () => {
    assert(detectSurge(spikeIn20Days(CONFIG.SURGE_MIN_COUNT), "p"));
  });
  it("리뷰가 없으면 null", () => eq(detectSurge([], "p"), null));
  it("리뷰가 없는 날도 평균에 들어간다 (중간에 빈 날이 있어도 날짜 막대가 이어진다)", () => {
    const reviews = [...perDay("p", "2026-10-01", [1]), ...perDay("p", "2026-10-20", [1])];
    eq(detectSurge(reviews, "p"), null); // 20일에 걸친 리뷰 2건: 급증 아님
  });
});

describe("detectSkew: 평점 쏠림", () => {
  const ratings = (...counts) => counts.flatMap((n, i) => Array.from({ length: n }, (_, k) => rv("p", i + 1, `t${i}${k}`, "2026-10-01")));

  it("한 평점이 70% 이상이면 감지하고 그 평점의 리뷰가 근거가 된다", () => {
    const s = detectSkew(ratings(2, 1, 1, 1, 15), "p"); // 5점 75%
    assert(s);
    eq(s.type, "skew");
    eq(s.evidence.length, 15);
    assert(s.evidence.every((r) => r.rating === 5));
    deepEq(s.bars.map((b) => b.value), [2, 1, 1, 1, 15]);
    eq(s.bars.filter((b) => b.highlight).length, 1);
    eq(s.severity, "low");
  });
  it("경계: 정확히 70%는 감지, 70% 미만은 아니다", () => {
    assert(detectSkew(ratings(2, 2, 2, 0, 14), "p")); // 14/20 = 0.7
    eq(detectSkew(ratings(2, 2, 2, 1, 13), "p"), null); // 13/20 = 0.65
  });
  it("표본이 SKEW_MIN_REVIEWS건 미만이면 100%여도 판단하지 않는다", () => {
    eq(detectSkew(ratings(0, 0, 0, 0, CONFIG.SKEW_MIN_REVIEWS - 1), "p"), null);
    assert(detectSkew(ratings(0, 0, 0, 0, CONFIG.SKEW_MIN_REVIEWS), "p"));
  });
  it("심각도: 85% 이상 높음, 80% 이상 중간, 그 외 낮음", () => {
    eq(detectSkew(ratings(3, 0, 0, 0, 17), "p").severity, "high"); // 85%
    eq(detectSkew(ratings(4, 0, 0, 0, 16), "p").severity, "medium"); // 80%
    eq(detectSkew(ratings(5, 0, 0, 0, 15), "p").severity, "low"); // 75%
  });
  it("고르게 퍼져 있으면 null", () => eq(detectSkew(ratings(4, 4, 4, 4, 4), "p"), null));
  it("빈 배열도 안전", () => eq(detectSkew([], "p"), null));
});

describe("detectRepeat: 반복 문구", () => {
  const spam = "지금 구매하면 사은품 증정 이벤트 진행 중";
  it("같은 문장이 3건 이상 서로 다른 리뷰에 있으면 감지", () => {
    const reviews = [
      rv("p", 5, `좋아요 정말. ${spam}!`, "2026-10-01"),
      rv("p", 5, `${spam}.`, "2026-10-02"),
      rv("p", 4, `배송 빨라요. ${spam}`, "2026-10-03"),
      rv("p", 3, "평범한 리뷰입니다 그냥저냥 씁니다.", "2026-10-03"),
    ];
    const s = detectRepeat(reviews, "p");
    assert(s);
    eq(s.type, "repeat");
    eq(s.evidence.length, 3);
    eq(s.phrases[0].count, 3);
    eq(s.bars.filter((b) => b.highlight).length, 3);
  });
  it("대소문자·구두점·공백 차이는 같은 문장으로 본다", () => {
    const reviews = [
      rv("p", 5, "Buy NOW at the best price!!", "2026-10-01"),
      rv("p", 5, "buy now, at the   best price", "2026-10-02"),
      rv("p", 5, "BUY NOW AT THE BEST PRICE.", "2026-10-03"),
    ];
    assert(detectRepeat(reviews, "p"));
  });
  it("2건만 같으면 감지하지 않는다 (경계)", () => {
    eq(detectRepeat([rv("p", 5, spam, "2026-10-01"), rv("p", 5, spam, "2026-10-02")], "p"), null);
  });
  it("한 리뷰 안에서 같은 문장을 여러 번 써도 1건으로 센다", () => {
    eq(detectRepeat([rv("p", 5, `${spam}. ${spam}. ${spam}.`, "2026-10-01"), rv("p", 5, spam, "2026-10-02")], "p"), null);
  });
  it("짧은 문구('좋아요')는 아무리 반복돼도 이상으로 보지 않는다", () => {
    const reviews = Array.from({ length: 10 }, (_, i) => rv("p", 5, "좋아요", `2026-10-0${(i % 9) + 1}`));
    eq(detectRepeat(reviews, "p"), null);
  });
  it("심각도: 반복 문구가 들어간 리뷰 수 기준", () => {
    const make = (n) => Array.from({ length: n }, (_, i) => rv("p", 5, spam, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`));
    eq(detectRepeat(make(3), "p").severity, "low");
    eq(detectRepeat(make(CONFIG.REPEAT_MEDIUM), "p").severity, "medium");
    eq(detectRepeat(make(CONFIG.REPEAT_HIGH), "p").severity, "high");
  });
  it("빈 배열·문구 없는 리뷰도 안전", () => {
    eq(detectRepeat([], "p"), null);
    eq(detectRepeat([rv("p", 5, "", "2026-10-01"), rv("p", 5, "!!!", "2026-10-02")], "p"), null);
  });
});

describe("normalizePhrase · highlightSegments (F-06)", () => {
  it("normalizePhrase: 소문자, 기호 제거, 공백 정리", () => {
    eq(normalizePhrase("  Hello,   WORLD!! (사용 3일차) "), "hello world 사용 3일차");
    eq(normalizePhrase("..."), "");
  });
  it("조각을 이어 붙이면 원문과 같고, 반복 문장만 mark", () => {
    const text = "배송 빨라요. 이 제품 정말 최고예요 강력 추천!\n또 살게요.";
    const phrases = [{ key: normalizePhrase("이 제품 정말 최고예요 강력 추천") }];
    const segs = highlightSegments(text, phrases);
    eq(segs.map((s) => s.text).join(""), text);
    const marked = segs.filter((s) => s.mark);
    eq(marked.length, 1);
    assert(marked[0].text.includes("강력 추천"));
  });
  it("phrases가 없으면 전체가 mark 아님", () => {
    const segs = highlightSegments("안녕하세요. 반갑습니다.");
    assert(segs.every((s) => !s.mark));
    eq(segs.map((s) => s.text).join(""), "안녕하세요. 반갑습니다.");
  });
  it("빈 문자열도 안전", () => deepEq(highlightSegments(""), []));
});

describe("detectSignals: 목록과 정렬 (R-02, F-04)", () => {
  it("상품별로 따로 계산한다 (한 상품의 급증이 다른 상품에 섞이지 않는다)", () => {
    const quiet = flat(20, 1);
    const spike = [...quiet];
    spike[7] = 30;
    const reviews = [...perDay("a", "2026-10-01", spike), ...perDay("b", "2026-10-01", quiet)];
    const signals = detectSignals(reviews);
    deepEq(signals.filter((s) => s.type === "surge").map((s) => s.product_id), ["a"]);
  });
  it("심각도(높음 → 낮음) 순으로 정렬한다", () => {
    const spam = "지금 구매하면 사은품 증정 이벤트 진행 중";
    const many = Array.from({ length: 12 }, (_, i) => rv("hi", 5, spam, `2026-10-${String(i + 1).padStart(2, "0")}`)); // 높음
    const few = Array.from({ length: 3 }, (_, i) => rv("lo", 5, spam, `2026-10-0${i + 1}`)); // 낮음
    const order = detectSignals([...few, ...many]).map((s) => s.severity);
    deepEq(order, [...order].sort((x, y) => ({ high: 0, medium: 1, low: 2 })[x] - ({ high: 0, medium: 1, low: 2 })[y]));
    eq(order[0], "high");
    eq(order.at(-1), "low");
  });
  it("skipSkew: 평점 필터가 켜진 경우 쏠림은 계산하지 않는다", () => {
    const ones = Array.from({ length: 30 }, (_, i) => rv("p", 1, `t${i}`, "2026-10-01"));
    eq(detectSignals(ones).some((s) => s.type === "skew"), true);
    eq(detectSignals(ones, { skipSkew: true }).some((s) => s.type === "skew"), false);
  });
  it("신호 id는 유형과 상품으로 정해져 필터가 바뀌어도 같은 신호를 가리킨다", () => {
    const ones = Array.from({ length: 30 }, (_, i) => rv("p-1", 1, `t${i}`, "2026-10-01"));
    eq(detectSignals(ones)[0].id, "skew:p-1");
  });
  it("빈 데이터는 빈 목록", () => deepEq(detectSignals([]), []));
});

describe("샘플 데이터 (data/reviews.sample.json): 심어 둔 사례가 화면 신호로 나온다", () => {
  it("정확히 1,000건이고 레코드가 모두 유효하며 생성 데이터로 표시돼 있다", async () => {
    const { reviews, meta, skipped } = parseDataset(await loadSample());
    eq(reviews.length, 1000);
    eq(skipped, 0);
    eq(meta.generated, true);
    deepEq(reviews.map((r) => r.id), reviews.map((_, i) => i + 1)); // id 1..1000, 시간순
  });
  it("심어 둔 급증·쏠림·반복 6건을 모두 찾고, 그 밖의 신호(오탐)는 없다", async () => {
    const { reviews, meta } = parseDataset(await loadSample());
    const found = detectSignals(reviews).map((s) => s.id).sort();
    const planted = [
      ...meta.planted.surge.map((s) => `surge:${s.product_id}`),
      ...meta.planted.skew.map((s) => `skew:${s.product_id}`),
      ...meta.planted.repeat.map((s) => `repeat:${s.product_id}`),
    ].sort();
    deepEq(found, planted);
  });
  it("급증은 심어 둔 날짜를 가리킨다", async () => {
    const { reviews, meta } = parseDataset(await loadSample());
    for (const planted of meta.planted.surge) {
      const signal = detectSignals(reviews).find((s) => s.id === `surge:${planted.product_id}`);
      assert(signal.reason.includes(planted.date), `${planted.product_id}: ${planted.date}`);
    }
  });
  it("세 심각도가 모두 나타난다 (정렬·표시 확인용)", async () => {
    const { reviews } = parseDataset(await loadSample());
    const levels = new Set(detectSignals(reviews).map((s) => s.severity));
    deepEq([...levels].sort(), ["high", "low", "medium"]);
  });
});

describe("paginate / pageWindow (F-02)", () => {
  const items = Array.from({ length: 12 }, (_, i) => i + 1);
  it("페이지별로 자르고 마지막 페이지는 나머지만", () => {
    deepEq(paginate(items, 1, 5).items, [1, 2, 3, 4, 5]);
    deepEq(paginate(items, 3, 5).items, [11, 12]);
    eq(paginate(items, 1, 5).totalPages, 3);
  });
  it("범위를 벗어난 페이지는 1~마지막으로 보정", () => {
    eq(paginate(items, 0, 5).page, 1);
    eq(paginate(items, -3, 5).page, 1);
    eq(paginate(items, 99, 5).page, 3);
  });
  it("정수가 아닌 페이지(NaN·소수·문자)는 1페이지", () => {
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
  it("정확히 나누어떨어지는 건수", () => eq(paginate(Array(10).fill(0), 1, 5).totalPages, 2));
  it("잘못된 페이지 크기는 1로 본다", () => eq(paginate(items, 1, 0).totalPages, 12));
  it("pageWindow: 적으면 전부, 많으면 …로 줄인다", () => {
    deepEq(pageWindow(1, 1), [1]);
    deepEq(pageWindow(2, 3), [1, 2, 3]);
    deepEq(pageWindow(5, 10), [1, "…", 4, 5, 6, "…", 10]);
    deepEq(pageWindow(1, 10), [1, 2, "…", 10]);
    deepEq(pageWindow(10, 10), [1, "…", 9, 10]);
    deepEq(pageWindow(3, 10), [1, 2, 3, 4, "…", 10]);
  });
});

describe("validateReview (F-01, U-24)", () => {
  const known = new Set(["prod-001", "prod-002"]);
  const ok = { product: "prod-001", rating: "4", text: "좋아요" };

  it("올바른 입력은 통과하고 값은 정리돼서 나온다", () => {
    const r = validateReview({ product: "  prod-001 ", rating: "4", text: "  좋아요  " }, known);
    eq(r.ok, true);
    deepEq(r.value, { product_id: "prod-001", rating: 4, text: "좋아요" });
  });
  it("상품: 비어 있거나 없는 상품이면 오류", () => {
    eq(validateReview({ ...ok, product: "" }, known).errors.product, "상품을 입력해 주세요.");
    assert(/존재하지 않는 상품/.test(validateReview({ ...ok, product: "prod-999" }, known).errors.product));
    assert(validateReview({ ...ok, product: "   " }, known).errors.product);
  });
  it("별점: 1~5 정수만 (문자열 숫자 허용)", () => {
    for (const bad of ["0", "6", "4.5", "abc", "", "  ", -1, NaN, null, undefined]) {
      assert(validateReview({ ...ok, rating: bad }, known).errors?.rating, `별점 ${bad}은 거부`);
    }
    for (const good of ["1", "5", 3, " 2 "]) eq(validateReview({ ...ok, rating: good }, known).ok, true, `별점 ${good}은 허용`);
  });
  it("내용: 비어 있거나 공백만이면 오류", () => {
    assert(validateReview({ ...ok, text: "" }, known).errors.text);
    assert(validateReview({ ...ok, text: " \n\t  " }, known).errors.text);
  });
  it("내용 길이 경계: 500자는 통과, 501자는 오류 (앞뒤 공백은 세지 않는다)", () => {
    eq(validateReview({ ...ok, text: "가".repeat(CONFIG.TEXT_MAX) }, known).ok, true);
    eq(validateReview({ ...ok, text: ` ${"가".repeat(CONFIG.TEXT_MAX)} ` }, known).ok, true);
    assert(validateReview({ ...ok, text: "가".repeat(CONFIG.TEXT_MAX + 1) }, known).errors.text);
  });
  it("여러 오류를 한 번에 알려준다", () => {
    const r = validateReview({ product: "", rating: "9", text: "" }, known);
    deepEq(Object.keys(r.errors).sort(), ["product", "rating", "text"]);
  });
  it("인자가 비어도 던지지 않는다", () => eq(validateReview(undefined, known).ok, false));
});

describe("parseDataset / loadDataset (F-03)", () => {
  const good = { id: 1, product_id: "p", rating: 5, text: "t", created_at: "2026-10-01T00:00:00.000Z" };

  it("배열과 { meta, reviews } 두 형태를 받는다", () => {
    eq(parseDataset([good]).reviews.length, 1);
    const wrapped = parseDataset({ meta: { generated: true }, reviews: [good] });
    eq(wrapped.reviews.length, 1);
    eq(wrapped.meta.generated, true);
  });
  it("형식이 틀린 레코드는 건너뛰고 건수를 알려준다", () => {
    const bad = [
      null, 3, "x", {}, { ...good, id: "1" }, { ...good, id: 1.5 }, { ...good, product_id: "" }, { ...good, rating: 0 },
      { ...good, rating: 6 }, { ...good, rating: "5" }, { ...good, text: 1 }, { ...good, created_at: "어제" }, { ...good, created_at: null },
    ];
    const r = parseDataset([good, ...bad]);
    eq(r.reviews.length, 1);
    eq(r.skipped, bad.length);
  });
  it("배열이 아니면 에러", () => {
    for (const bad of [null, undefined, 5, "x", {}, { reviews: "x" }]) throws(() => parseDataset(bad), /형식/);
  });
  it("빈 배열은 정상 (빈 상태)", () => deepEq(parseDataset([]).reviews, []));
  it("loadDataset: 성공", async () => {
    const fake = async () => ({ ok: true, json: async () => [good] });
    eq((await loadDataset("x", fake)).reviews.length, 1);
  });
  it("loadDataset: 네트워크 실패·HTTP 오류·JSON 오류를 사람이 읽을 수 있는 메시지로", async () => {
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
  it("nextId: 가장 큰 id + 1, 비어 있으면 1", () => {
    eq(nextId([]), 1);
    eq(nextId([{ id: 3 }, { id: 10 }, { id: 7 }]), 11);
  });
  it("productIds: 중복 없이 정렬", () => {
    deepEq(productIds([{ product_id: "b" }, { product_id: "a" }, { product_id: "b" }]), ["a", "b"]);
  });
});
