// 기능 테스트 (Q-02): 고객 문의 이상 탐지 페이지를 실제로 띄우고, 입력·클릭 이벤트로 동작을 검증한다.
// 핵심 확인: 입력에 따라 "관련 영역만" 갱신되고 나머지 DOM 노드는 그대로 유지된다 (R-06, T-04, P2-32, 4.3.2 표).
import { describe, it, assert, eq, deepEq, tick } from "./runner.js";
import { mountApp } from "../src/voc/app.js";
import { parseDataset } from "../src/voc/data.js";
import { detectAlerts, hourRange } from "../src/voc/analysis.js";
import { countDomChanges } from "../src/diff.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// 화면 밖에 두되 문서에는 붙여 둔다 (포커스가 실제로 동작하도록)
const sandbox = document.createElement("div");
sandbox.style.cssText = "position:fixed;left:-9999px;top:0;width:1100px";
document.body.appendChild(sandbox);

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/inquiries.sample.json").then((r) => r.json()));
/** 이 데이터에서 화면에 나와야 하는 발생 건 수 (화면과 같은 함수로 따로 계산해서, 화면 연결이 맞는지 확인하는 기준) */
const expectedAlertCount = (data) => detectAlerts(data.inquiries, hourRange(data.inquiries)).length;

/** 앱을 띄우고 데이터가 들어올 때까지 기다린 뒤 fn({ c, box, $, $$, data })을 실행한다 */
async function withApp(fn, { dataset, props } = {}) {
  const box = document.createElement("div");
  sandbox.appendChild(box);
  try {
    const data = dataset ?? parseDataset(await loadSample());
    const c = mountApp(box, { load: () => Promise.resolve(data), ...props });
    await tick(0);
    await fn({ c, box, data, $: (s) => box.querySelector(s), $$: (s) => [...box.querySelectorAll(s)] });
  } finally {
    box.remove();
  }
}

const type = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = (el, value) => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); };
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

/** 신호 카드를 유형 이름과 범위(포함되는 글)로 찾는다 */
const card = ({ $$ }, label, scope) =>
  $$(".alert-card").find((b) => b.querySelector(".alert-type").textContent === label && (!scope || b.querySelector(".alert-scope").textContent.includes(scope)));
const cardLabels = ({ $$ }) => $$(".alert-card").map((b) => `${b.querySelector(".alert-type").textContent}|${b.querySelector(".alert-scope").textContent}`);
/** 기기·버전 쏠림 카드의 "얼마나" 문구 (예: "Android 97% · 앱 4.4.0 94%") */
const envMetrics = ({ $$ }) =>
  $$(".alert-card")
    .filter((b) => b.querySelector(".alert-type").textContent === "기기·버전 쏠림")
    .map((b) => b.querySelector(".alert-metric").textContent);
const nextPage = ({ $ }, times = 1) => {
  for (let i = 0; i < times; i++) click($('.pager button[aria-label="다음 페이지"]'));
};
const evidenceCount = ({ $ }) => Number(/(\d[\d,]*)건/.exec($(".evidence h3").textContent)[1].replace(/,/g, ""));

/** 지켜봐야 할 영역의 노드와 HTML을 기록해 두고, 나중에 "그대로인지" 확인한다 */
const snapshot = ($, selectors) => selectors.map((s) => ({ s, node: $(s), html: $(s).outerHTML }));
function assertUntouched($, snap) {
  for (const { s, node, html } of snap) {
    assert($(s) === node, `${s}: DOM 노드가 교체되었다`);
    eq($(s).outerHTML, html, `${s}: 내용이 바뀌었다`);
  }
}

describe("페이지 상태: 로딩 · 오류 · 빈 상태 (F-03)", () => {
  it("로딩 중에는 각 데이터 영역에 '불러오는 중'이 보이고, 끝나면 데이터로 바뀐다", async () => {
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      let resolve;
      const pending = new Promise((r) => (resolve = r));
      mountApp(box, { load: () => pending });
      await tick(0);
      for (const area of [".summary", ".signal-list", ".signal-detail"]) assert(box.querySelector(`${area} .status-loading`), `${area} 로딩 표시`);
      assert(!box.querySelector(".badge"), "데이터가 오기 전에는 생성 데이터 표시도 없다");

      const data = parseDataset(await loadSample());
      resolve(data);
      await tick(0);
      assert(!box.querySelector(".status-loading"));
      assert(text(box.querySelector(".summary")).includes("3,000건"));
      eq(box.querySelectorAll(".alert-card").length, expectedAlertCount(data));
      assert(box.querySelector(".badge"));
    } finally {
      box.remove();
    }
  });

  it("불러오기에 실패하면 모든 데이터 영역에 오류가 표시된다", async () => {
    const box = document.createElement("div");
    sandbox.appendChild(box);
    try {
      mountApp(box, { load: () => Promise.reject(new Error("문의 데이터를 불러오지 못했습니다. (HTTP 500)")) });
      await tick(0);
      for (const area of [".summary", ".signal-list", ".signal-detail"]) {
        const err = box.querySelector(`${area} .status-error`);
        assert(err, `${area} 오류 표시`);
        eq(err.getAttribute("role"), "alert");
        assert(err.textContent.includes("HTTP 500"));
      }
    } finally {
      box.remove();
    }
  });

  it("문의가 0건이면 빈 상태 문구가 보이고 화면이 깨지지 않는다", async () => {
    await withApp(({ $, $$ }) => {
      assert(text($(".summary")).includes("조건에 맞는 문의가 없습니다"));
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(text($(".signal-detail")).includes("이상 신호를 선택하세요"));
      eq($$(".alert-card").length, 0);
    }, { dataset: parseDataset([]) });
  });

  it("형식이 틀린 레코드는 건너뛰고 몇 건을 제외했는지 알려준다", async () => {
    const good = { id: 1, category: "배송", text: "t", app_version: "4.3.0", device: "iOS", created_at: "2026-10-01T00:00:00.000Z" };
    await withApp(({ $ }) => {
      assert(text($(".summary")).includes("1건"));
      assert(text($(".notice")).includes("2건은 제외"));
    }, { dataset: parseDataset([good, { id: "x" }, null]) });
  });
});

describe("첫 화면 (R-01 ~ R-05)", () => {
  it("헤더·요약·심각도순 가로 카드·첫 신호 상세(이유·차트·근거 문의)가 보인다", async () => {
    await withApp(({ $, $$, data }) => {
      assert(text($(".app-header")).includes("OBJECT NOTE 고객 문의 이상 탐지"));
      assert($(".badge"), "생성 데이터 표시");
      assert(text($(".summary")).includes("3,000건") && text($(".summary")).includes("최다 유형"));
      eq($$(".alert-card").length, expectedAlertCount(data));
      const rank = { 높음: 3, 중간: 2, 낮음: 1 };
      const sev = $$(".alert-card .sev").map((s) => rank[s.textContent]);
      assert(sev.every((v, i) => i === 0 || sev[i - 1] >= v), "심각도 높은 순");
      eq($$(".alert-card.selected").length, 1);
      assert($(".alert-card").classList.contains("selected"), "첫 신호가 선택돼 있다");
      assert($(".reason p").textContent.length > 20, "감지 이유");
      assert($(".chart-svg rect"), "차트");
      assert($$(".inquiry").length > 0 && $$(".inquiry").length <= 5, "근거 문의는 한 페이지 5건 이하");
    });
  });

  it("네 가지 신호가 모두 카드로 나온다 (R-02)", async () => {
    await withApp(({ $$ }) => {
      const types = new Set($$(".alert-card .alert-type").map((e) => e.textContent));
      deepEq([...types].sort(), ["기기·버전 쏠림", "문의 급증", "반복 문구", "유형 쏠림"]);
    });
  });

  it("차트는 SVG 네임스페이스로 만들어진다", async () => {
    await withApp(({ $ }) => {
      eq($(".chart-svg").namespaceURI, SVG_NS);
      eq($(".chart-svg rect").namespaceURI, SVG_NS);
    });
  });

  it("카드는 가로로 배열되고, 상세 영역은 카드 아래 전체 너비다 (실제 voc.html을 iframe으로 띄워 확인)", async () => {
    // test.html에는 페이지 CSS가 없으므로 배치는 실제 페이지에서 확인한다
    const frame = document.createElement("iframe");
    frame.src = "./voc.html";
    frame.style.cssText = "width:1100px;height:900px;border:0";
    sandbox.appendChild(frame);
    try {
      await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = reject; });
      const doc = frame.contentDocument;
      for (let i = 0; i < 80 && !doc.querySelector(".alert-card"); i++) await tick(50);
      const [a, b] = doc.querySelectorAll(".alert-card");
      assert(a && b, "카드가 그려져야 한다");
      assert(Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2, "첫 두 카드가 같은 줄");
      const list = doc.querySelector(".signal-list").getBoundingClientRect();
      const detail = doc.querySelector(".signal-detail").getBoundingClientRect();
      assert(detail.top > list.top, "상세는 목록 아래");
      assert(detail.width >= list.width - 2, "상세도 전체 너비");
    } finally {
      frame.remove();
    }
  });
});

describe("필터 → 관련 영역만 갱신 (R-03, R-06, T-04, P2-32, 4.3.2)", () => {
  it("문의 검색: 입력창 노드와 포커스가 유지되고, 머리글은 그대로. 검색된 문의만으로 신호를 다시 계산한다", async () => {
    await withApp(({ c, $, $$ }) => {
      const input = $("input[name=query]");
      input.focus();
      const snap = snapshot($, [".app-header"]);
      for (const value of ["카", "카카", "카카오"]) type(input, value);

      assert($("input[name=query]") === input, "입력창 DOM 노드가 그대로");
      eq(document.activeElement, input, "입력 중에도 포커스 유지");
      assert(text($(".summary")).includes("24건"), `카카오 로그인 문의는 24건: ${text($(".summary"))}`);
      // 검색된 24건은 한 시간에 6건씩이라 기준(20건)에 못 미쳐 이상 신호가 없다
      eq($$(".alert-card").length, 0);
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(countDomChanges(c.lastChanges) > 0);
      assertUntouched($, snap);
    });
  });

  it("문의 검색: 같은 문구 문의만 남기면 그 유형·문구의 신호만 남는다", async () => {
    await withApp((app) => {
      const total = app.$$(".alert-card").length;
      type(app.$("input[name=query]"), "쿠폰이 적용됐다고");
      const labels = cardLabels(app);
      assert(labels.length > 0 && labels.length < total, labels.join());
      assert(labels.every((l) => l.includes("쿠폰") || l.startsWith("반복 문구")), labels.join());
    });
  });

  it("기간: 최근 24시간이면 그 기간에 끝난 신호만 남고, '평소' 이력은 자르지 않아 급증이 그대로 판정된다", async () => {
    await withApp(({ $, $$, data }) => {
      choose($("select[name=period]"), "24h");
      const cards = $$(".alert-card");
      assert(cards.length > 0 && cards.length < expectedAlertCount(data));
      assert(cards.every((b) => b.querySelector(".alert-time").textContent.startsWith("11-09")), "마지막 날 신호만");
      assert(cardLabels({ $$ }).some((l) => l.startsWith("문의 급증|로그인·계정")), "이력을 잘랐다면 급증을 판정하지 못한다");
      const onLastDay = data.inquiries.filter((q) => q.created_at.startsWith("2026-11-09")).length;
      assert(text($(".summary")).includes(`${onLastDay.toLocaleString("ko-KR")}건`), "요약 건수도 기간에 맞는다");
    });
  });

  it("유형 필터: 한 유형만 남으면 유형 쏠림은 계산하지 않고, 요약의 최다 유형이 그 유형이다", async () => {
    await withApp((app) => {
      assert(cardLabels(app).some((l) => l.startsWith("유형 쏠림")));
      choose(app.$("select[name=category]"), "로그인·계정");
      assert(!cardLabels(app).some((l) => l.startsWith("유형 쏠림")), "유형 필터가 켜지면 유형 쏠림은 없다");
      assert(cardLabels(app).some((l) => l.startsWith("문의 급증|로그인·계정")));
      assert(text(app.$(".summary")).includes("최다 유형 로그인·계정"));
    });
  });

  it("기기 필터: 기기 쏠림은 계산하지 않고 앱 버전 쏠림만 남는다", async () => {
    await withApp((app) => {
      choose(app.$("select[name=device]"), "Android");
      const env = envMetrics(app);
      assert(env.length > 0, "버전 쏠림은 남는다");
      assert(env.every((s) => s.includes("앱 ") && !/Android|iOS|Web/.test(s)), env.join()); // 기기 비율은 없고 앱 버전 비율만 있다
    });
  });

  it("앱 버전 필터: 버전 쏠림은 계산하지 않고 기기 쏠림만 남는다", async () => {
    await withApp((app) => {
      choose(app.$("select[name=appVersion]"), "4.4.0");
      const env = envMetrics(app);
      assert(env.length > 0, "기기 쏠림은 남는다");
      assert(env.every((s) => !s.includes("앱 ") && /Android|iOS|Web/.test(s)), env.join()); // 앱 버전 비율은 없고 기기 비율만 있다
    });
  });

  it("필터 초기화: 모든 필터가 초기값으로 돌아가고 목록이 복원된다 (F-07)", async () => {
    await withApp(({ $, $$, data }) => {
      const input = $("input[name=query]");
      type(input, "로그인");
      choose($("select[name=period]"), "3d");
      choose($("select[name=category]"), "로그인·계정");
      choose($("select[name=device]"), "Android");
      choose($("select[name=appVersion]"), "4.4.0");
      click($(".filter-bar .btn-ghost"));
      eq(input.value, "");
      for (const name of ["period", "category", "device", "appVersion"]) eq($(`select[name=${name}]`).value, "all", name);
      eq($$(".alert-card").length, expectedAlertCount(data));
      assert($("input[name=query]") === input, "입력창 노드는 그대로");
    });
  });

  it("조건에 맞는 문의가 없으면 빈 상태, 지우면 다시 돌아온다", async () => {
    await withApp(({ $, $$, data }) => {
      const input = $("input[name=query]");
      type(input, "zzz-없는-문구");
      assert(text($(".summary")).includes("조건에 맞는 문의가 없습니다"));
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(text($(".signal-detail")).includes("이상 신호를 선택하세요"));
      type(input, "");
      eq($$(".alert-card").length, expectedAlertCount(data));
      assert(text($(".summary")).includes("3,000건"));
    });
  });

  it("검색어 앞뒤 공백·대문자도 같은 결과를 낸다", async () => {
    await withApp((app) => {
      type(app.$("input[name=query]"), "  쿠폰이 적용됐다고  ");
      const a = cardLabels(app);
      type(app.$("input[name=query]"), "쿠폰이 적용됐다고");
      deepEq(cardLabels(app), a);
    });
  });
});

describe("신호 선택과 차트 (R-02, R-04, C5)", () => {
  it("신호를 선택하면 강조가 옮겨지고 상세가 바뀐다. ①②③은 그대로", async () => {
    await withApp(({ $, $$ }) => {
      const snap = snapshot($, [".app-header", ".filter-bar", ".summary"]);
      const before = $(".reason h3").textContent;
      click($$(".alert-card")[1]);
      eq($$(".alert-card.selected").length, 1);
      assert($$(".alert-card")[1].classList.contains("selected"));
      eq($$(".alert-card")[1].getAttribute("aria-pressed"), "true");
      eq($$(".alert-card")[0].getAttribute("aria-pressed"), "false");
      assert($(".reason h3").textContent !== before, "상세가 바뀌었다");
      assertUntouched($, snap);
    });
  });

  it("신호 유형마다 차트가 다르다: 급증=시간별, 유형 쏠림=유형 분포, 기기·버전=두 막대, 반복=시간별 반복 수", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      const captions = () => $$(".chart figcaption").map((f) => f.textContent);

      click(card(app, "문의 급증", "로그인·계정"));
      eq($$(".chart").length, 1);
      assert(captions()[0].startsWith("시간별 문의 수"));
      assert($$(".chart-svg rect.bar-hl").length >= 1, "급증한 시각이 강조");

      click(card(app, "유형 쏠림", "반품·환불"));
      eq($$(".chart").length, 1);
      eq(captions()[0], "문의 유형 분포 (발생 구간)");
      eq($$(".chart-svg rect").length, 7);
      eq($$(".chart-svg rect.bar-hl").length, 1, "쏠린 유형 하나가 강조");

      click(card(app, "기기·버전 쏠림", "로그인·계정"));
      eq($$(".chart").length, 2, "기기별 막대 + 앱 버전별 막대");
      deepEq(captions(), ["기기별 문의 수 (발생 구간)", "앱 버전별 문의 수 (발생 구간)"]);
      eq($$(".chart")[0].querySelectorAll("rect").length, 3, "iOS / Android / Web");

      click(card(app, "반복 문구", "쿠폰이 적용됐다고"));
      eq($$(".chart").length, 1);
      eq(captions()[0], "시간별 반복 문구 문의 수");
    });
  });
});

describe("근거 문의 · 페이지 나누기 · 반복 문구 강조 (R-05, F-02, F-06)", () => {
  it("페이지 이동: 근거 문의 목록만 바뀌고 이유·차트·신호 목록 등은 그대로", async () => {
    await withApp(({ c, $, $$ }) => {
      const snap = snapshot($, [".app-header", ".filter-bar", ".summary", ".signal-list", ".reason", ".charts"]);
      const firstIds = $$(".inquiry-id").map((e) => e.textContent);
      click($$(".pager .page").find((b) => b.textContent === "2"));
      const secondIds = $$(".inquiry-id").map((e) => e.textContent);
      eq(secondIds.length, 5);
      assert(secondIds.every((id) => !firstIds.includes(id)), "다른 문의가 보인다");
      eq($(".pager .page.current").textContent, "2");
      assert(countDomChanges(c.lastChanges) > 0);
      assertUntouched($, snap);
    });
  });

  it("페이지 경계: 첫 페이지에서 이전은 막히고, 마지막 페이지는 나머지 건수만 보이며 다음이 막힌다", async () => {
    await withApp((app) => {
      const { $, $$ } = app;
      const n = evidenceCount(app);
      const pages = Math.ceil(n / 5);
      assert(pages > 2, `페이지가 여러 개여야 한다 (n=${n})`);
      eq($('.pager button[aria-label="이전 페이지"]').disabled, true);
      nextPage(app, pages - 1);
      eq($(".pager .page.current").textContent, String(pages));
      eq($$(".inquiry").length, n - 5 * (pages - 1), "마지막 페이지는 나머지만");
      eq($('.pager button[aria-label="다음 페이지"]').disabled, true);
      click($('.pager button[aria-label="이전 페이지"]'));
      eq($(".pager .page.current").textContent, String(pages - 1));
    });
  });

  it("신호를 바꾸면 1페이지로 돌아간다", async () => {
    await withApp((app) => {
      nextPage(app, 2);
      eq(app.$(".pager .page.current").textContent, "3");
      click(app.$$(".alert-card")[1]);
      assert(!app.$(".pager") || app.$(".pager .page.current").textContent === "1");
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
      choose($("select[name=period]"), "7d");
      eq(updates, 1, "기간 변경 + 페이지 1로 = setState 2번이지만 렌더링은 1번");
      assert(!$(".pager") || $(".pager .page.current").textContent === "1", "1페이지");
    });
  });

  it("선택한 신호가 필터로 사라지면 첫 신호가 대신 선택된다 (화면이 비지 않는다)", async () => {
    await withApp((app) => {
      click(card(app, "반복 문구", "쿠폰이 적용됐다고"));
      assert(text(app.$(".reason h3")).includes("반복 문구"));
      choose(app.$("select[name=category]"), "로그인·계정"); // 쿠폰 문의가 사라져 그 반복 문구 신호도 사라진다
      assert(!cardLabels(app).some((l) => l.includes("쿠폰이 적용됐다고")));
      eq(app.$$(".alert-card.selected").length, 1);
      assert(app.$(".reason p").textContent.length > 20, "상세가 비지 않았다");
    });
  });

  it("반복 문구 신호의 근거 문의에서는 반복된 문장이 mark로 강조된다 (주문번호가 달라도)", async () => {
    await withApp((app) => {
      click(card(app, "반복 문구", "쿠폰이 적용됐다고"));
      const marks = app.$$(".inquiry-text mark");
      assert(marks.length > 0, "강조가 있어야 한다");
      assert(marks.every((m) => m.textContent.includes("결제 금액이 그대로예요")));
      assert(text(app.$(".reason")).includes("결제 금액이 그대로예요"));
    });
  });

  it("다른 신호에서는 강조가 없다", async () => {
    await withApp((app) => {
      click(card(app, "문의 급증", "로그인·계정"));
      eq(app.$$(".inquiry-text mark").length, 0);
    });
  });

  it("근거 문의에는 번호·유형·기기·앱 버전·시각이 보인다", async () => {
    await withApp((app) => {
      click(card(app, "기기·버전 쏠림", "로그인·계정"));
      const meta = app.$(".inquiry-meta").textContent; // 첫 건이 시나리오 문의가 아닌 평소 문의일 수 있으니 값이 아니라 형식을 본다
      assert(/#\d+/.test(meta), `번호: ${meta}`);
      assert(meta.includes("로그인·계정"), `유형: ${meta}`);
      assert(/iOS|Android|Web/.test(meta), `기기: ${meta}`);
      assert(/\d+\.\d+\.\d+|web/.test(meta), `앱 버전: ${meta}`);
      assert(/2026-11-09 \d\d:\d\d/.test(meta), `시각: ${meta}`);
    });
  });
});

describe("진행 상태 (F-08, R-14) — Step 1 임시 버전", () => {
  const T = "2026-11-10T12:34:56.000Z";
  const stepBtn = ({ $$ }, label) => $$(".status-steps button").find((b) => b.textContent === label);
  const histRows = ({ $$ }) => $$(".status-history li:not(.muted)").map((li) => li.querySelector(".hist-status").textContent);
  const withStatusApp = (fn) => withApp(fn, { props: { now: () => T } });

  it("신호를 고르면 진행 현황이 그 신호 기준으로 보이고, 처음엔 '확인 필요'에 이력이 없다", async () => {
    await withStatusApp((ctx) => {
      const { $, $$, data } = ctx;
      assert($(".progress"), "진행 현황 패널");
      // 처음에는 첫 신호가 선택되어 있고, 패널은 그 신호의 ID를 가리킨다 (기대값은 분석 함수로 따로 계산)
      eq($(".progress").getAttribute("data-alert"), detectAlerts(data.inquiries, hourRange(data.inquiries))[0].id);
      eq($$(".status-steps button").length, 5);
      eq($(".status-steps .current").textContent, "확인 필요");
      assert(text($(".status-history")).includes("변경 이력이 없습니다"));
      // 모든 카드에 상태가 적힌다 (이력이 없는 신호는 '확인 필요')
      eq($$(".alert-status").length, $$(".alert-card").length);
      assert($$(".alert-status").every((s) => s.textContent === "상태 · 확인 필요"));
      assert($$(".alert-card").every((b) => b.classList.contains("st-0")), "처음엔 모두 첫 단계 색");
    });
  });

  it("단계마다 카드의 색 클래스가 바뀐다 (확인 필요 st-0 → 분석 중 st-1 → … → 해결 st-4)", async () => {
    await withStatusApp((ctx) => {
      const { $$ } = ctx;
      ["확인 필요", "분석 중", "유관부서 전달", "조치 중", "해결"].forEach((label, i) => {
        click(stepBtn(ctx, label));
        assert($$(".alert-card")[0].classList.contains(`st-${i}`), `${label} → st-${i}`);
        eq($$(".alert-card")[0].className.match(/st-\d/g).length, 1, "색 클래스는 하나만 붙는다");
        assert($$(".status-steps .current")[0].classList.contains(`st-${i}`), "패널의 현재 단계 버튼도 같은 색");
      });
      assert($$(".alert-card")[1].classList.contains("st-0"), "다른 카드는 그대로");
    });
  });

  it("진행 현황 필터로 같은 상태의 신호만 모아 볼 수 있다 (탐지 계산·요약은 그대로)", async () => {
    await withStatusApp((ctx) => {
      const { $, $$ } = ctx;
      const total = $$(".alert-card").length;
      const summary = text($(".summary"));
      click(stepBtn(ctx, "분석 중")); // 첫 카드 → 분석 중
      click($$(".alert-card")[1]);
      click(stepBtn(ctx, "해결")); // 둘째 카드 → 해결

      choose($("select[name=statusFilter]"), "분석 중");
      eq($$(".alert-card").length, 1);
      assert(text($$(".alert-card")[0]).includes("상태 · 분석 중"));
      choose($("select[name=statusFilter]"), "해결");
      eq($$(".alert-card").length, 1);
      choose($("select[name=statusFilter]"), "확인 필요");
      eq($$(".alert-card").length, total - 2, "이력이 없는 신호는 '확인 필요'로 모인다");
      eq(text($(".summary")), summary, "요약은 진행 현황 필터의 영향을 받지 않는다");
      choose($("select[name=statusFilter]"), "all");
      eq($$(".alert-card").length, total);
    });
  });

  it("해당 상태의 신호가 없으면 빈 상태가 보이고, 초기화하면 진행 현황 필터도 돌아온다", async () => {
    await withStatusApp((ctx) => {
      const { $, $$ } = ctx;
      const total = $$(".alert-card").length;
      choose($("select[name=statusFilter]"), "조치 중");
      eq($$(".alert-card").length, 0);
      assert(text($(".signal-list")).includes("감지된 이상 신호가 없습니다"));
      assert(!$(".progress"), "선택할 신호가 없으면 진행 현황도 없다");
      click([...$$("button")].find((b) => b.textContent === "초기화"));
      eq($("select[name=statusFilter]").value, "all");
      eq($$(".alert-card").length, total);
      assert($(".progress"));
    });
  });

  it("상태를 바꿀 때마다 이력에 새 행이 붙고 이전 행은 그대로다 (R-14: 이전 행을 수정하지 않는다)", async () => {
    await withStatusApp((ctx) => {
      const { $, $$ } = ctx;
      click(stepBtn(ctx, "분석 중"));
      deepEq(histRows(ctx), ["분석 중"]);
      const firstRowHtml = $$(".status-history li")[0].outerHTML;
      click(stepBtn(ctx, "조치 중"));
      deepEq(histRows(ctx), ["조치 중", "분석 중"], "최신이 위");
      eq($$(".status-history li")[1].outerHTML, firstRowHtml, "이전 행은 그대로");
      eq($(".status-steps .current").textContent, "조치 중", "현재 상태 = 가장 마지막 행");
      assert(text($(".status-history")).includes("11-10 12:34 UTC"), "바뀐 시각이 이력에 보인다");
    });
  });

  it("어느 단계로든 바꿀 수 있고, 잘못 눌러도 이전 단계로 되돌릴 수 있다 (되돌려도 이력은 남는다)", async () => {
    await withStatusApp((ctx) => {
      const { $$ } = ctx;
      // 현재가 '확인 필요'일 때 나머지 네 버튼이 모두 눌릴 수 있다 (건너뛰기 허용)
      eq($$(".status-steps button:disabled").length, 0);
      click(stepBtn(ctx, "해결")); // 확인 필요 → 해결 (건너뛰기)
      deepEq(histRows(ctx), ["해결"]);
      click(stepBtn(ctx, "분석 중")); // 해결 → 분석 중 (되돌리기)
      deepEq(histRows(ctx), ["분석 중", "해결"], "되돌려도 이전 기록은 남는다");
      click(stepBtn(ctx, "확인 필요")); // 처음 상태로도 되돌릴 수 있다
      eq($$(".status-steps .current")[0].textContent, "확인 필요");
      eq(histRows(ctx).length, 3);
    });
  });

  it("현재와 같은 상태를 누르면 이력에 행이 생기지 않는다", async () => {
    await withStatusApp((ctx) => {
      click(stepBtn(ctx, "분석 중"));
      click(stepBtn(ctx, "분석 중"));
      click(stepBtn(ctx, "확인 필요")); // 기본 상태로 되돌리는 것은 정책에 따라 막힐 수 있다 — 어느 쪽이든 같은 상태 반복은 행을 늘리지 않는다
      assert(histRows(ctx).filter((s) => s === "분석 중").length === 1);
    });
  });

  it("상태를 바꾸면 그 신호 카드의 상태만 바뀌고, 다른 신호의 상태와 섞이지 않는다", async () => {
    await withStatusApp((ctx) => {
      const { $$ } = ctx;
      const first = $$(".alert-card")[0];
      click(stepBtn(ctx, "분석 중"));
      eq($$(".alert-status").filter((s) => s.textContent === "상태 · 분석 중").length, 1);
      assert(text($$(".alert-card")[0]).includes("상태 · 분석 중"));
      assert(text($$(".alert-card")[1]).includes("상태 · 확인 필요"));
      click($$(".alert-card")[1]);
      eq($$(".status-steps .current")[0].textContent, "확인 필요", "다른 신호는 자기 상태를 가진다");
      eq(histRows(ctx).length, 0);
      click($$(".alert-card")[0]);
      eq($$(".status-steps .current")[0].textContent, "분석 중", "돌아오면 그대로");
      assert($$(".alert-card")[0] === first, "카드 DOM 노드는 교체되지 않았다");
    });
  });

  it("상태 변경은 관련 영역(카드의 상태 줄, 진행 현황)만 고치고 머리글·필터·요약·상세는 건드리지 않는다", async () => {
    await withStatusApp((ctx) => {
      const { $, c } = ctx;
      const snap = snapshot($, [".app-header", ".filter-bar", ".summary", ".signal-detail"]);
      click(stepBtn(ctx, "유관부서 전달"));
      assertUntouched($, snap);
      const touched = new Set(c.lastChanges.filter((x) => x.type !== "REBIND").map((x) => x.path[0]));
      for (const idx of [0, 1, 2, 4]) assert(!touched.has(idx), `자식 ${idx}번은 건드리지 않았다`);
    });
  });

  it("필터를 바꿔도 같은 신호면 같은 ID라서 상태가 이어진다 (U-28: ID = 유형·범위·시작 시각)", async () => {
    await withStatusApp((ctx) => {
      const { $, $$ } = ctx;
      const target = card(ctx, "문의 급증", "배송");
      click(target);
      click(stepBtn(ctx, "분석 중"));
      choose($("select[name=category]"), "배송");
      const same = card(ctx, "문의 급증", "배송");
      assert(same, "필터 뒤에도 같은 신호가 있다");
      assert(text(same).includes("상태 · 분석 중"), "상태가 이어진다");
      choose($("select[name=category]"), "all");
      assert(text(card(ctx, "문의 급증", "배송")).includes("상태 · 분석 중"));
      assert($$(".alert-status").length >= 1);
    });
  });
});

describe("Phase 1 ↔ Phase 2 연계: 상태가 바뀌면 Diff/Patch로 일부만 고친다 (P2-30 ~ P2-32)", () => {
  it("입력 한 번에 변경 목록이 만들어지고, 머리글 같은 영역의 변경은 없다", async () => {
    await withApp(({ c, $ }) => {
      const header = $(".app-header");
      type($("input[name=query]"), "쿠폰");
      assert(c.lastChanges.length > 0);
      assert([...new Set(c.lastChanges.map((x) => x.type))].every((k) => ["CREATE", "REMOVE", "REPLACE", "UPDATE_PROPS", "UPDATE_TEXT", "REBIND"].includes(k)));
      assert($(".app-header") === header);
      const touched = new Set(c.lastChanges.filter((x) => x.type !== "REBIND").map((x) => x.path[0]));
      assert(!touched.has(0), "머리글(첫 자식)은 건드리지 않았다");
    });
  });
});
