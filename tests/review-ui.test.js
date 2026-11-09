// 기능 테스트 (Q-02): 리뷰 이상 패턴 탐색 페이지를 실제로 띄우고, 입력·클릭 이벤트로 동작을 검증한다.
// 핵심 확인: 입력에 따라 "관련 영역만" 갱신되고 나머지 DOM 노드는 그대로 유지된다 (R-06, T-04, P2-32, 4.3.2 표).
import { describe, it, assert, eq, deepEq, tick } from "./runner.js";
import { mountApp } from "../src/review/app.js";
import { parseDataset } from "../src/review/data.js";
import { countDomChanges } from "../src/diff.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 화면 밖에 두되 문서에는 붙여 둔다 (포커스가 실제로 동작하도록)
const sandbox = document.createElement("div");
sandbox.style.cssText = "position:fixed;left:-9999px;top:0;width:1100px";
document.body.appendChild(sandbox);

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/reviews.sample.json").then((r) => r.json()));

/** 앱을 띄우고 데이터가 들어올 때까지 기다린 뒤 fn({ c, box, $, $$ })을 실행한다 */
async function withApp(fn, { dataset } = {}) {
  const box = document.createElement("div");
  sandbox.appendChild(box);
  try {
    const data = dataset ?? parseDataset(await loadSample());
    // now: 새 리뷰의 시각을 고정한다 (샘플의 마지막 날이 오늘이라 실제 시계에 기대면 "가장 최근"이 흔들린다)
    const c = mountApp(box, { load: () => Promise.resolve(data), now: () => new Date("2027-01-01T00:00:00.000Z") });
    await tick(0);
    await fn({ c, box, $: (s) => box.querySelector(s), $$: (s) => [...box.querySelectorAll(s)] });
  } finally {
    box.remove();
  }
}

const type = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = (el, value) => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); };
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const submit = (form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const titles = ({ $$ }) => $$(".signal-item").map((b) => `${b.querySelector(".signal-title").textContent}:${b.querySelector(".signal-product").textContent}`);
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

/** 지켜봐야 할 영역의 노드와 HTML을 기록해 두고, 나중에 "그대로인지" 확인한다 */
function snapshot($, selectors) {
  return selectors.map((s) => ({ s, node: $(s), html: $(s).outerHTML }));
}
function assertUntouched($, snap) {
  for (const { s, node, html } of snap) {
    assert($(s) === node, `${s}: DOM 노드가 교체되었다`);
    eq($(s).outerHTML, html, `${s}: 내용이 바뀌었다`);
  }
}
/** 제목(유형)과 상품으로 신호 버튼을 찾는다. 상품을 생략하면 그 유형의 첫 신호 */
const signalButton = ({ $$ }, label, product) =>
  $$(".signal-item").find((b) => b.querySelector(".signal-title").textContent === label && (!product || b.querySelector(".signal-product").textContent === product));
/** 근거 리뷰의 '다음 페이지' 버튼을 times번 누른다 (페이지 번호 버튼은 …로 줄어 있을 수 있다) */
const nextPage = ({ $ }, times = 1) => {
  for (let i = 0; i < times; i++) click($('.pager button[aria-label="다음 페이지"]'));
};

describe("페이지 상태: 로딩 · 오류 · 빈 상태 (F-03)", () => {
  it("로딩 중에는 각 데이터 영역에 '불러오는 중'이 보이고, 끝나면 데이터로 바뀐다", async () => {
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      let resolve;
      const pending = new Promise((r) => (resolve = r));
      mountApp(box, { load: () => pending });
      await tick(0);
      for (const area of [".summary", ".signal-list", ".signal-detail"]) {
        assert(box.querySelector(`${area} .status-loading`), `${area} 로딩 표시`);
      }
      eq(box.querySelector(".review-form button[type=submit]").disabled, true, "로딩 중에는 등록 불가");
      assert(!box.querySelector(".badge"), "데이터가 오기 전에는 생성 데이터 표시도 없다");

      resolve(parseDataset(await loadSample()));
      await tick(0);
      assert(!box.querySelector(".status-loading"));
      assert(text(box.querySelector(".summary")).includes("1,000건"));
      eq(box.querySelectorAll(".signal-item").length, 6);
      eq(box.querySelector(".review-form button[type=submit]").disabled, false);
    } finally {
      box.remove();
    }
  });

  it("불러오기에 실패하면 모든 데이터 영역에 오류가 표시되고 등록은 막힌다", async () => {
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      mountApp(box, { load: () => Promise.reject(new Error("리뷰 데이터를 불러오지 못했습니다. (HTTP 500)")) });
      await tick(0);
      for (const area of [".summary", ".signal-list", ".signal-detail"]) {
        const err = box.querySelector(`${area} .status-error`);
        assert(err, `${area} 오류 표시`);
        eq(err.getAttribute("role"), "alert");
        assert(err.textContent.includes("HTTP 500"));
      }
      eq(box.querySelector(".review-form button[type=submit]").disabled, true);
    } finally {
      box.remove();
    }
  });

  it("리뷰가 0건이면 빈 상태 문구가 보이고 화면이 깨지지 않는다", async () => {
    await withApp(({ $, $$ }) => {
      assert(text($(".summary")).includes("조건에 맞는 리뷰가 없습니다"));
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(text($(".signal-detail")).includes("이상 신호를 선택하세요"));
      eq($$(".signal-item").length, 0);
    }, { dataset: parseDataset([]) });
  });

  it("형식이 틀린 레코드는 건너뛰고 몇 건을 제외했는지 알려준다", async () => {
    const good = { id: 1, product_id: "p", rating: 5, text: "t", created_at: "2026-10-01T00:00:00.000Z" };
    await withApp(({ $ }) => {
      assert(text($(".summary")).includes("1건"));
      assert(text($(".notice")).includes("2건은 제외"));
    }, { dataset: parseDataset([good, { id: "x" }, null]) });
  });
});

describe("첫 화면 (R-01 ~ R-05)", () => {
  it("요약, 심각도순 신호 목록, 첫 신호 선택, 이유·차트·근거 리뷰가 보인다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      assert($(".badge"), "생성 데이터 표시");
      assert(text($(".summary")).includes("★3.6") && text($(".summary")).includes("1,000건"));
      eq($$(".signal-item").length, 6);
      const sev = $$(".signal-item .sev").map((s) => s.textContent);
      deepEq(sev, [...sev].sort((a, b) => ({ 높음: 0, 중간: 1, 낮음: 2 })[a] - ({ 높음: 0, 중간: 1, 낮음: 2 })[b]));
      eq($$(".signal-item.selected").length, 1);
      assert($(".signal-item").classList.contains("selected"), "첫 신호가 선택돼 있다");
      assert($(".reason p").textContent.length > 20, "감지 이유");
      assert($(".chart-svg rect"), "차트");
      assert($$(".review").length > 0 && $$(".review").length <= 5, "근거 리뷰는 한 페이지 5건 이하");
    });
  });

  it("차트는 SVG 네임스페이스로 만들어진다", async () => {
    await withApp(({ $ }) => {
      eq($(".chart-svg").namespaceURI, SVG_NS);
      eq($(".chart-svg rect").namespaceURI, SVG_NS);
    });
  });
});

describe("입력 → 관련 영역만 갱신 (R-06, T-04, P2-32, 4.3.2)", () => {
  it("상품 검색: 요약·신호·상세만 바뀌고 ①②⑥은 그대로. 입력창 노드와 포커스도 유지", async () => {
    await withApp(({ c, $, $$ }) => {
      const input = $("input[name=query]");
      input.focus();
      const snap = snapshot($, [".app-header", ".review-form"]);
      const before = $(".summary").outerHTML;

      for (const value of ["p", "pr", "prod", "prod-", "prod-0", "prod-00", "prod-003"]) type(input, value);

      assert($("input[name=query]") === input, "입력창 DOM 노드가 그대로");
      eq(document.activeElement, input, "입력 중에도 포커스 유지");
      eq(input.value, "prod-003");
      assert($(".summary").outerHTML !== before, "요약 갱신");
      deepEq(titles({ $$ }), ["리뷰 급증:prod-003"]);
      assert($(".reason h3").textContent.includes("prod-003"));
      assert(countDomChanges(c.lastChanges) > 0, "Diff가 변경 목록을 만들었다");
      assertUntouched($, snap);
    });
  });

  it("기간 필터: 최근 7일이면 그 기간에 해당하는 신호만 남는다", async () => {
    await withApp(({ $, $$ }) => {
      choose($("select[name=period]"), "7");
      assert(titles({ $$ }).length > 0 && titles({ $$ }).every((t) => t.startsWith("반복 문구")), titles({ $$ }).join());
    });
  });

  it("평점 필터: 평점을 고르면 요약이 바뀌고, 평점 쏠림 신호는 계산하지 않는다", async () => {
    await withApp(({ $, $$ }) => {
      assert(titles({ $$ }).some((t) => t.startsWith("평점 쏠림")));
      choose($("select[name=rating]"), "1");
      assert(text($(".summary")).includes("★1.0"));
      assert(!titles({ $$ }).some((t) => t.startsWith("평점 쏠림")), "한 평점만 남기면 쏠림은 의미가 없다");
    });
  });

  it("조건에 맞는 리뷰가 없으면 빈 상태, 지우면 다시 돌아온다", async () => {
    await withApp(({ $, $$ }) => {
      const input = $("input[name=query]");
      type(input, "zzz-없는-상품");
      assert(text($(".summary")).includes("조건에 맞는 리뷰가 없습니다"));
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(text($(".signal-detail")).includes("이상 신호를 선택하세요"));
      type(input, "");
      eq($$(".signal-item").length, 6);
      assert(text($(".summary")).includes("1,000건"));
    });
  });

  it("필터 초기화: 검색어·기간·평점이 초기값으로 돌아가고 목록이 복원된다 (F-07)", async () => {
    await withApp(({ $, $$ }) => {
      const input = $("input[name=query]");
      type(input, "003");
      choose($("select[name=period]"), "30");
      choose($("select[name=rating]"), "5");
      click($(".filter-bar .btn-ghost"));
      eq(input.value, "");
      eq($("select[name=period]").value, "all");
      eq($("select[name=rating]").value, "all");
      eq($$(".signal-item").length, 6);
      assert($("input[name=query]") === input, "입력창 노드는 그대로");
    });
  });

  it("검색어 앞뒤 공백·대문자도 같은 결과를 낸다", async () => {
    await withApp(({ $, $$ }) => {
      type($("input[name=query]"), "  PROD-003  ");
      deepEq(titles({ $$ }), ["리뷰 급증:prod-003"]);
    });
  });
});

describe("신호 선택과 근거 리뷰 페이지 (R-02, F-02)", () => {
  it("신호를 선택하면 강조가 옮겨지고 상세가 바뀐다. ①②③⑥은 그대로", async () => {
    await withApp(({ $, $$ }) => {
      const snap = snapshot($, [".app-header", ".filter-bar", ".summary", ".review-form"]);
      const second = $$(".signal-item")[1];
      const secondTitle = text(second);
      click(second);
      eq($$(".signal-item.selected").length, 1);
      assert($$(".signal-item")[1].classList.contains("selected"));
      eq($$(".signal-item")[1].getAttribute("aria-pressed"), "true");
      eq($$(".signal-item")[0].getAttribute("aria-pressed"), "false");
      assert(secondTitle.includes($(".reason h3").textContent.split(" · ")[1].slice(0, 8)));
      assertUntouched($, snap);
    });
  });

  it("신호 유형마다 차트가 다르다 (C5): 급증=일별, 쏠림=평점 분포(5개), 반복=일별 반복 수", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "리뷰 급증"));
      eq($(".chart figcaption").textContent, "일별 리뷰 수");
      eq($$(".chart-svg rect.bar-hl").length, 1, "급증한 날 하나가 강조");

      click(signalButton(app, "평점 쏠림"));
      eq($(".chart figcaption").textContent, "평점 분포");
      eq($$(".chart-svg rect").length, 5);
      eq($$(".chart-svg rect.bar-hl").length, 1);

      click(signalButton(app, "반복 문구"));
      eq($(".chart figcaption").textContent, "일별 반복 문구 리뷰 수");
      assert($$(".chart-svg rect.bar-hl").length >= 2, "반복이 있던 날들이 강조");
    });
  });

  it("근거 리뷰 페이지 이동: 근거 리뷰 목록만 바뀌고 이유·차트·신호 목록 등은 그대로", async () => {
    await withApp(({ c, $, $$ }) => {
      const snap = snapshot($, [".app-header", ".filter-bar", ".summary", ".signal-list", ".reason", ".chart", ".review-form"]);
      const firstIds = $$(".review-id").map((e) => e.textContent);
      const page2 = $$(".pager .page").find((b) => b.textContent === "2");
      click(page2);
      const secondIds = $$(".review-id").map((e) => e.textContent);
      eq(secondIds.length, 5);
      assert(secondIds.every((id) => !firstIds.includes(id)), "다른 리뷰가 보인다");
      eq($(".pager .page.current").textContent, "2");
      assert(countDomChanges(c.lastChanges) > 0);
      assertUntouched($, snap);
    });
  });

  it("페이지 경계: 첫 페이지에서 이전은 막히고, 마지막 페이지는 나머지 건수만 보이며 다음이 막힌다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "평점 쏠림", "prod-002")); // 근거 107건 = 22페이지, 마지막 페이지는 2건
      assert(text($(".evidence h3")).includes("107건"));
      eq($('.pager button[aria-label="이전 페이지"]').disabled, true);
      for (let i = 0; i < 21; i++) click($('.pager button[aria-label="다음 페이지"]'));
      eq($(".pager .page.current").textContent, "22");
      eq($$(".review").length, 2);
      eq($('.pager button[aria-label="다음 페이지"]').disabled, true);
      click($('.pager button[aria-label="이전 페이지"]'));
      eq($(".pager .page.current").textContent, "21");
    });
  });

  it("신호를 바꾸면 1페이지로 돌아간다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      nextPage(app, 2);
      eq($(".pager .page.current").textContent, "3");
      click(app.$$(".signal-item")[1]);
      assert(!$(".pager") || $(".pager .page.current").textContent === "1");
    });
  });

  it("필터를 바꾸면 1페이지로 돌아가며, 렌더링은 한 번만 일어난다 (Batching)", async () => {
    await withApp((app) => {
      const { c, $ } = app;
      nextPage(app, 2);
      eq($(".pager .page.current").textContent, "3");

      let updates = 0;
      const original = c.update.bind(c);
      c.update = () => { updates++; return original(); };
      choose($("select[name=period]"), "60");

      eq(updates, 1, "기간 변경 + 페이지 1로 = setState 2번이지만 렌더링은 1번");
      assert(!$(".pager") || $(".pager .page.current").textContent === "1", "1페이지");
    });
  });

  it("선택한 신호가 필터로 사라지면 첫 신호가 대신 선택된다 (화면이 비지 않는다)", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "반복 문구", "prod-008"));
      assert($(".reason h3").textContent.includes("prod-008"));
      type($("input[name=query]"), "003");
      deepEq(titles(app), ["리뷰 급증:prod-003"]);
      assert($(".reason h3").textContent.includes("prod-003"));
      eq($$(".signal-item.selected").length, 1);
    });
  });
});

describe("반복 문구 강조 (F-06)", () => {
  it("반복 문구 신호의 근거 리뷰에서는 반복된 문장이 mark로 강조된다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "반복 문구", "prod-005"));
      const marks = $$(".review-text mark");
      assert(marks.length > 0, "강조가 있어야 한다");
      assert(marks.every((m) => m.textContent.includes("인생이 바뀌었어요")));
      assert(text($(".reason")).includes("인생이 바뀌었어요"));
    });
  });
  it("다른 신호에서는 강조가 없다", async () => {
    await withApp(({ $$ }) => {
      eq($$(".review-text mark").length, 0);
    });
  });
});

describe("새 리뷰 작성 (F-01, U-24)", () => {
  const fill = ({ $ }, { product, rating, text: body }) => {
    if (product !== undefined) type($("#f-product"), product);
    if (rating !== undefined) choose($("#f-rating"), rating);
    if (body !== undefined) type($("#f-text"), body);
  };

  it("내용이 비어 있으면 등록되지 않고 오류가 보인다. 입력을 시작하면 오류가 사라진다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      fill(app, { product: "prod-003", text: "   " });
      submit($(".review-form"));
      assert(text($(".review-form")).includes("내용을 입력해 주세요"));
      assert(text($(".form-message")).includes("입력을 확인해 주세요"));
      assert(text($(".summary")).includes("1,000건"), "등록되지 않음");
      type($("#f-text"), "다시 씀");
      eq($$(".field-error").length, 0);
      eq($$(".form-message").length, 0);
    });
  });

  it("없는 상품이면 오류", async () => {
    await withApp((app) => {
      fill(app, { product: "prod-999", text: "좋아요" });
      submit(app.$(".review-form"));
      assert(text(app.$(".review-form")).includes("존재하지 않는 상품입니다: prod-999"));
      assert(text(app.$(".summary")).includes("1,000건"));
    });
  });

  it("여러 칸이 틀리면 오류를 한꺼번에 보여준다", async () => {
    await withApp((app) => {
      submit(app.$(".review-form"));
      eq(app.$$(".field-error").length, 2, "상품과 내용");
    });
  });

  it("정상 등록: 건수가 늘고, 근거 리뷰·요약이 갱신되고, 폼이 비워지고, ①②는 그대로", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "평점 쏠림", "prod-002"));
      assert(text($(".evidence h3")).includes("107건"));
      const snap = snapshot($, [".app-header", ".filter-bar"]);

      fill(app, { product: "prod-002", rating: "1", text: "정말 별로예요 새로 쓴 리뷰" });
      submit($(".review-form"));

      assert(text($(".summary")).includes("1,001건"));
      assert(text($(".evidence h3")).includes("108건"), "쏠림 신호의 근거가 늘었다");
      assert(text($(".review")).includes("정말 별로예요 새로 쓴 리뷰"), "가장 최근 리뷰가 맨 위");
      assert(text($(".form-message")).includes("#1001"));
      eq($("#f-product").value, "");
      eq($("#f-text").value, "");
      eq($$(".field-error").length, 0);
      assertUntouched($, snap);
    });
  });

  it("글자 수 경계: 500자는 등록, 501자는 오류", async () => {
    await withApp((app) => {
      fill(app, { product: "prod-001", text: "가".repeat(501) });
      submit(app.$(".review-form"));
      assert(text(app.$(".review-form")).includes("500자 이하"));
      assert(text(app.$(".summary")).includes("1,000건"));
      type(app.$("#f-text"), "가".repeat(500));
      submit(app.$(".review-form"));
      assert(text(app.$(".summary")).includes("1,001건"));
    });
  });

  it("HTML 태그가 들어 있어도 글자 그대로 보이고 요소로 만들어지지 않는다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      click(signalButton(app, "평점 쏠림", "prod-002"));
      fill(app, { product: "prod-002", rating: "1", text: '<img src=x onerror="window.__xss=1"><b>굵게</b>' });
      submit($(".review-form"));
      assert(text($(".review")).includes("<img src=x"), "태그가 글자로 보임");
      eq($$(".review-text img").length, 0);
      eq($$(".review-text b").length, 0);
      eq(window.__xss, undefined);
    });
  });

  it("연속으로 두 번 등록하면 id가 이어지고 건수가 정확히 2 늘어난다", async () => {
    await withApp((app) => {
      fill(app, { product: "prod-001", text: "첫째" });
      submit(app.$(".review-form"));
      fill(app, { product: "prod-001", text: "둘째" });
      submit(app.$(".review-form"));
      assert(text(app.$(".summary")).includes("1,002건"));
      assert(text(app.$(".form-message")).includes("#1002"));
    });
  });
});

describe("Phase 1 ↔ Phase 2 연계: 상태가 바뀌면 Diff/Patch로 일부만 고친다 (P2-30 ~ P2-32)", () => {
  it("검색 입력 한 번에 실제 DOM 변경 목록이 만들어지고, 머리글·폼 같은 영역의 변경은 없다", async () => {
    await withApp(({ c, $ }) => {
      const form = $(".review-form");
      const header = $(".app-header");
      type($("input[name=query]"), "003");
      assert(c.lastChanges.length > 0);
      const kinds = new Set(c.lastChanges.map((x) => x.type));
      assert([...kinds].every((k) => ["CREATE", "REMOVE", "REPLACE", "UPDATE_PROPS", "UPDATE_TEXT", "REBIND"].includes(k)));
      assert($(".review-form") === form && $(".app-header") === header);
      // 화면 전체(루트 div) 바로 아래 첫 번째 자식(머리글)·마지막 자식(폼 또는 안내문구)에 대한 변경이 없는지 경로로 확인
      const touched = new Set(c.lastChanges.filter((x) => x.type !== "REBIND").map((x) => x.path[0]));
      assert(!touched.has(0), "머리글(첫 자식)은 건드리지 않았다");
    });
  });
});
