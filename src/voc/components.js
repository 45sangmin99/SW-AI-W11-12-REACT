// 고객 문의(VOC) 이상 탐지 화면의 컴포넌트 (요구사항 4.3, 4.3.1)
// 전부 props만 받는 순수 함수다 (C-03, C-04): 상태·Hook 없음. 이벤트는 App이 내려준 콜백으로 올린다.
// ⑥ 진행 현황(F-08)과 ⑦ 성능 비교는 Step 4 전용이라 여기에 없다.
import { h } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { SIGNAL_LABEL, SEVERITY_LABEL, formatRange, highlightSegments } from "./analysis.js";
import { pageWindow } from "./pagination.js";

const STATUS_TEXT = { loading: "불러오는 중…", empty: "표시할 내용이 없습니다.", error: "문제가 발생했습니다." };

// ---------------------------------------------------------------- 공통: StatusView (F-03)
export function StatusView({ status, message }) {
  return h(
    "div",
    { class: `status status-${status}`, role: status === "error" ? "alert" : "status" },
    message || STATUS_TEXT[status] || "",
  );
}

// ---------------------------------------------------------------- ① Header
export function Header({ isGenerated }) {
  return h(
    "header",
    { class: "app-header" },
    h("h1", null, "OBJECT NOTE 고객 문의 이상 탐지"),
    isGenerated
      ? h("span", { class: "badge", title: "가상의 회사 OBJECT NOTE의 시연용 데이터입니다. 실제 고객 문의가 아닙니다." }, "생성 데이터")
      : null,
  );
}

// ---------------------------------------------------------------- ② FilterBar (R-03, F-07)
const field = (label, control) => h("label", { class: "field" }, h("span", null, label), control);
const allOption = (text) => h("option", { value: "all" }, text);

export function FilterBar({ query, period, category, device, appVersion, appVersions, onQuery, onPeriod, onCategory, onDevice, onVersion, onReset }) {
  return h(
    "section",
    { class: "filter-bar", "aria-label": "필터" },
    field("문의 검색", h("input", { type: "search", name: "query", value: query, placeholder: "문의 내용에서 찾기", autocomplete: "off", onInput: (e) => onQuery(e.target.value) })),
    field("기간", h("select", { name: "period", value: period, onChange: (e) => onPeriod(e.target.value) }, CONFIG.PERIODS.map((p) => h("option", { value: p.value }, p.label)))),
    field("유형", h("select", { name: "category", value: category, onChange: (e) => onCategory(e.target.value) }, allOption("전체 유형"), CONFIG.CATEGORIES.map((c) => h("option", { value: c }, c)))),
    field("기기", h("select", { name: "device", value: device, onChange: (e) => onDevice(e.target.value) }, allOption("전체 기기"), CONFIG.DEVICES.map((d) => h("option", { value: d }, d)))),
    field("앱 버전", h("select", { name: "appVersion", value: appVersion, onChange: (e) => onVersion(e.target.value) }, allOption("전체 버전"), appVersions.map((v) => h("option", { value: v }, v)))),
    h("button", { type: "button", class: "btn btn-ghost", onClick: onReset }, "초기화"),
  );
}

// ---------------------------------------------------------------- ③ SummaryCard (F-05)
export function SummaryCard({ summary, status, message }) {
  if (status !== "ready") return h("section", { class: "summary" }, h(StatusView, { status, message }));
  if (summary.count === 0) return h("section", { class: "summary" }, h(StatusView, { status: "empty", message: "조건에 맞는 문의가 없습니다." }));
  return h(
    "section",
    { class: "summary", "aria-label": "요약" },
    h("span", { class: "summary-item" }, "문의 ", h("strong", null, `${summary.count.toLocaleString("ko-KR")}건`)),
    h("span", { class: "summary-sep" }, "·"),
    h("span", { class: "summary-item" }, "최다 유형 ", h("strong", null, summary.topCategory), ` (${summary.topCount.toLocaleString("ko-KR")}건)`),
  );
}

// ---------------------------------------------------------------- ④ SignalList (R-02, F-04): 가로 카드
export function SignalList({ alerts, selectedId, onSelect, status, message }) {
  let body;
  if (status !== "ready") body = h(StatusView, { status, message });
  else if (alerts.length === 0) body = h(StatusView, { status: "empty", message: "감지된 이상 신호가 없습니다." });
  else {
    body = h(
      "ul",
      { class: "alert-cards" },
      alerts.map((a) =>
        h(
          "li",
          null,
          h(
            "button",
            {
              type: "button",
              class: a.id === selectedId ? "alert-card selected" : "alert-card",
              "aria-pressed": a.id === selectedId ? "true" : "false",
              onClick: () => onSelect(a.id),
            },
            h("span", { class: "alert-head" }, h("span", { class: `sev sev-${a.severity}` }, SEVERITY_LABEL[a.severity]), h("span", { class: "alert-type" }, SIGNAL_LABEL[a.type])),
            h("span", { class: "alert-scope", title: a.scopeLabel }, a.scopeLabel),
            h("span", { class: "alert-time" }, formatRange(a.startHour, a.endHour)),
          ),
        ),
      ),
    );
  }
  return h("section", { class: "panel signal-list", "aria-label": "이상 신호 목록" }, h("h2", null, "이상 신호"), body);
}

// ---------------------------------------------------------------- ⑤-a SignalReason (R-05)
export function SignalReason({ alert }) {
  return h(
    "div",
    { class: "reason" },
    h("h3", null, `${SIGNAL_LABEL[alert.type]} · ${alert.type === "repeat" ? "같은 문구" : alert.category}`, h("span", { class: `sev sev-${alert.severity}` }, SEVERITY_LABEL[alert.severity])),
    h("p", null, alert.reason),
  );
}

// ---------------------------------------------------------------- ⑤-b SignalChart (R-04, C5)
// 막대 차트를 SVG로 직접 그린다 (C-11: 외부 라이브러리 없음). 막대 하나하나가 Virtual DOM 노드라서
// 신호를 바꾸거나 데이터가 바뀌면 달라진 막대의 속성(height 등)만 Patch된다.
const r2 = (n) => Math.round(n * 100) / 100;

export function BarChart({ title, bars }) {
  const W = 560, H = 210, L = 34, R = 8, T = 22, B = 30;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = plotW / Math.max(bars.length, 1);
  const few = bars.length <= 12; // 막대가 적으면 값과 이름을 모두, 많으면 몇 개만
  const barW = Math.max(1, slot * (few ? 0.6 : 0.8));
  const labelEvery = few ? 1 : Math.ceil(bars.length / 6);
  const nameOf = (b) => (few ? b.label : (b.short ?? b.label));

  const rects = bars.map((b, i) => {
    const height = (b.value / max) * plotH;
    return h(
      "rect",
      { x: r2(L + i * slot + (slot - barW) / 2), y: r2(T + plotH - height), width: r2(barW), height: r2(height), class: b.highlight ? "bar bar-hl" : "bar" },
      h("title", null, `${b.label}: ${b.value}건`),
    );
  });
  const labels = bars.flatMap((b, i) =>
    i % labelEvery === 0 ? [h("text", { x: r2(L + i * slot + slot / 2), y: H - 10, class: "axis-label", "text-anchor": "middle" }, nameOf(b))] : [],
  );
  const values = few
    ? bars.map((b, i) =>
        h("text", { x: r2(L + i * slot + slot / 2), y: r2(T + plotH - (b.value / max) * plotH - 4), class: "value-label", "text-anchor": "middle" }, b.value),
      )
    : [];

  return h(
    "figure",
    { class: "chart" },
    h("figcaption", null, title),
    h(
      "svg",
      { class: "chart-svg", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}, 최댓값 ${max}건` },
      h("line", { class: "axis", x1: L, y1: T + plotH, x2: W - R, y2: T + plotH }),
      h("text", { x: L - 4, y: T + 4, class: "axis-label", "text-anchor": "end" }, max),
      h("text", { x: L - 4, y: T + plotH, class: "axis-label", "text-anchor": "end" }, 0),
      rects,
      values,
      labels,
    ),
  );
}

/** 신호마다 차트가 1~2개다 (기기·버전 쏠림은 기기별 막대 + 앱 버전별 막대) */
export function SignalChart({ alert }) {
  return h("div", { class: "charts" }, alert.charts.map((chart) => h(BarChart, { title: chart.title, bars: chart.bars })));
}

// ---------------------------------------------------------------- ⑤-c EvidenceList (R-05, F-02, F-06)
export function Pager({ page, totalPages, onPageChange }) {
  return h(
    "nav",
    { class: "pager", "aria-label": "근거 문의 페이지" },
    h("button", { type: "button", class: "btn btn-ghost", disabled: page <= 1, onClick: () => onPageChange(page - 1), "aria-label": "이전 페이지" }, "◀"),
    pageWindow(page, totalPages).map((n) =>
      n === "…"
        ? h("span", { class: "pager-gap" }, "…")
        : h("button", { type: "button", class: n === page ? "btn page current" : "btn page", "aria-current": n === page ? "page" : "false", onClick: () => onPageChange(n) }, n),
    ),
    h("button", { type: "button", class: "btn btn-ghost", disabled: page >= totalPages, onClick: () => onPageChange(page + 1), "aria-label": "다음 페이지" }, "▶"),
  );
}

function InquiryItem({ inquiry, phrases }) {
  return h(
    "li",
    { class: "inquiry" },
    h(
      "div",
      { class: "inquiry-meta" },
      h("span", { class: "inquiry-id" }, `#${inquiry.id}`),
      h("span", { class: "tag" }, inquiry.category),
      h("span", null, inquiry.device),
      h("span", null, inquiry.app_version),
      h("span", null, inquiry.created_at.slice(0, 16).replace("T", " ")),
    ),
    h("p", { class: "inquiry-text" }, highlightSegments(inquiry.text, phrases).map((seg) => (seg.mark ? h("mark", null, seg.text) : seg.text))),
  );
}

export function EvidenceList({ alert, evidence, onPageChange }) {
  return h(
    "section",
    { class: "evidence", "aria-label": "근거 문의" },
    h("h3", null, `근거 문의 ${evidence.total.toLocaleString("ko-KR")}건`),
    h("ul", { class: "inquiry-list" }, evidence.items.map((inquiry) => h(InquiryItem, { inquiry, phrases: alert.phrases }))),
    evidence.totalPages > 1 ? h(Pager, { page: evidence.page, totalPages: evidence.totalPages, onPageChange }) : null,
  );
}

// ---------------------------------------------------------------- ⑤ SignalDetail (전체 너비)
export function SignalDetail({ alert, evidence, onPageChange, status, message }) {
  let body;
  if (status !== "ready") body = h(StatusView, { status, message });
  else if (!alert) body = h(StatusView, { status: "empty", message: "위 목록에서 이상 신호를 선택하세요." });
  else body = h("div", { class: "detail-body" }, h(SignalReason, { alert }), h(SignalChart, { alert }), h(EvidenceList, { alert, evidence, onPageChange }));
  return h("section", { class: "panel signal-detail", "aria-label": "신호 상세" }, body);
}
