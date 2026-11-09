// 리뷰 이상 패턴 탐색 화면의 컴포넌트 (요구사항 4.3, 4.3.1)
// 전부 props만 받는 순수 함수다 (C-03, C-04): 상태·Hook 없음. 이벤트는 App이 내려준 콜백으로 올린다.
import { h } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { SIGNAL_LABEL, SEVERITY_LABEL, highlightSegments } from "./analysis.js";
import { pageWindow } from "./pagination.js";

const STATUS_TEXT = { loading: "불러오는 중…", empty: "표시할 내용이 없습니다.", error: "문제가 발생했습니다." };
const dateOf = (iso) => iso.slice(0, 10);

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
    h("h1", null, "리뷰 이상 패턴 탐색"),
    isGenerated ? h("span", { class: "badge", title: "실제 리뷰가 아니라 시연을 위해 만든 데이터입니다" }, "생성 데이터") : null,
  );
}

// ---------------------------------------------------------------- ② FilterBar (R-03, F-07)
export function FilterBar({ query, period, rating, onQuery, onPeriod, onRating, onReset }) {
  return h(
    "section",
    { class: "filter-bar", "aria-label": "필터" },
    h(
      "label",
      { class: "field" },
      h("span", null, "상품 검색"),
      h("input", { type: "search", name: "query", value: query, placeholder: "예: prod-003", autocomplete: "off", onInput: (e) => onQuery(e.target.value) }),
    ),
    h(
      "label",
      { class: "field" },
      h("span", null, "기간"),
      h("select", { name: "period", value: period, onChange: (e) => onPeriod(e.target.value) }, CONFIG.PERIODS.map((p) => h("option", { value: p.value }, p.label))),
    ),
    h(
      "label",
      { class: "field" },
      h("span", null, "평점"),
      h(
        "select",
        { name: "rating", value: rating, onChange: (e) => onRating(e.target.value) },
        h("option", { value: "all" }, "전체 평점"),
        [5, 4, 3, 2, 1].map((n) => h("option", { value: String(n) }, `${n}점`)),
      ),
    ),
    h("button", { type: "button", class: "btn btn-ghost", onClick: onReset }, "초기화"),
  );
}

// ---------------------------------------------------------------- ③ SummaryCard (F-05)
export function SummaryCard({ summary, status, message }) {
  if (status !== "ready") return h("section", { class: "summary" }, h(StatusView, { status, message }));
  if (summary.count === 0) return h("section", { class: "summary" }, h(StatusView, { status: "empty", message: "조건에 맞는 리뷰가 없습니다." }));
  return h(
    "section",
    { class: "summary", "aria-label": "요약" },
    h("span", { class: "summary-item" }, "평균 별점 ", h("strong", null, `★${summary.average.toFixed(1)}`)),
    h("span", { class: "summary-sep" }, "·"),
    h("span", { class: "summary-item" }, "리뷰 ", h("strong", null, `${summary.count.toLocaleString("ko-KR")}건`)),
  );
}

// ---------------------------------------------------------------- ④ SignalList (R-02, F-04)
export function SignalList({ signals, selectedId, onSelect, status, message }) {
  let body;
  if (status !== "ready") body = h(StatusView, { status, message });
  else if (signals.length === 0) body = h(StatusView, { status: "empty", message: "감지된 이상 신호가 없습니다." });
  else {
    body = h(
      "ul",
      { class: "signals" },
      signals.map((s) =>
        h(
          "li",
          null,
          h(
            "button",
            {
              type: "button",
              class: s.id === selectedId ? "signal-item selected" : "signal-item",
              "aria-pressed": s.id === selectedId ? "true" : "false",
              onClick: () => onSelect(s.id),
            },
            h("span", { class: `sev sev-${s.severity}` }, SEVERITY_LABEL[s.severity]),
            h("span", { class: "signal-title" }, SIGNAL_LABEL[s.type]),
            h("span", { class: "signal-product" }, s.product_id),
          ),
        ),
      ),
    );
  }
  return h("section", { class: "panel signal-list", "aria-label": "이상 신호 목록" }, h("h2", null, "이상 신호"), body);
}

// ---------------------------------------------------------------- ⑤-a SignalReason (R-05)
export function SignalReason({ signal }) {
  return h(
    "div",
    { class: "reason" },
    h("h3", null, `${SIGNAL_LABEL[signal.type]} · ${signal.product_id}`, h("span", { class: `sev sev-${signal.severity}` }, SEVERITY_LABEL[signal.severity])),
    h("p", null, signal.reason),
    signal.type === "repeat" && signal.phrases.length > 1
      ? h("ul", { class: "phrases" }, signal.phrases.slice(0, 3).map((p) => h("li", null, `"${p.text}" — ${p.count}건`)))
      : null,
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

  const rects = bars.map((b, i) => {
    const height = (b.value / max) * plotH;
    return h(
      "rect",
      { x: r2(L + i * slot + (slot - barW) / 2), y: r2(T + plotH - height), width: r2(barW), height: r2(height), class: b.highlight ? "bar bar-hl" : "bar" },
      h("title", null, `${b.label}: ${b.value}건`),
    );
  });
  const labels = bars.flatMap((b, i) =>
    i % labelEvery === 0
      ? [h("text", { x: r2(L + i * slot + slot / 2), y: H - 10, class: "axis-label", "text-anchor": "middle" }, few ? b.label : b.label.slice(5))]
      : [],
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

export function SignalChart({ signal }) {
  return h(BarChart, { title: signal.chartTitle, bars: signal.bars });
}

// ---------------------------------------------------------------- ⑤-c EvidenceList (R-05, F-02, F-06)
export function Pager({ page, totalPages, onPageChange }) {
  return h(
    "nav",
    { class: "pager", "aria-label": "근거 리뷰 페이지" },
    h("button", { type: "button", class: "btn btn-ghost", disabled: page <= 1, onClick: () => onPageChange(page - 1), "aria-label": "이전 페이지" }, "◀"),
    pageWindow(page, totalPages).map((n) =>
      n === "…"
        ? h("span", { class: "pager-gap" }, "…")
        : h("button", { type: "button", class: n === page ? "btn page current" : "btn page", "aria-current": n === page ? "page" : "false", onClick: () => onPageChange(n) }, n),
    ),
    h("button", { type: "button", class: "btn btn-ghost", disabled: page >= totalPages, onClick: () => onPageChange(page + 1), "aria-label": "다음 페이지" }, "▶"),
  );
}

function ReviewItem({ review, phrases }) {
  return h(
    "li",
    { class: "review" },
    h("div", { class: "review-meta" }, h("span", { class: "stars" }, `★${review.rating}`), h("span", null, review.product_id), h("span", null, dateOf(review.created_at)), h("span", { class: "review-id" }, `#${review.id}`)),
    h("p", { class: "review-text" }, highlightSegments(review.text, phrases).map((seg) => (seg.mark ? h("mark", null, seg.text) : seg.text))),
  );
}

export function EvidenceList({ signal, evidence, onPageChange }) {
  return h(
    "section",
    { class: "evidence", "aria-label": "근거 리뷰" },
    h("h3", null, `근거 리뷰 ${evidence.total.toLocaleString("ko-KR")}건`),
    h("ul", { class: "review-list" }, evidence.items.map((review) => h(ReviewItem, { review, phrases: signal.phrases }))),
    evidence.totalPages > 1 ? h(Pager, { page: evidence.page, totalPages: evidence.totalPages, onPageChange }) : null,
  );
}

// ---------------------------------------------------------------- ⑤ SignalDetail
export function SignalDetail({ signal, evidence, onPageChange, status, message }) {
  let body;
  if (status !== "ready") body = h(StatusView, { status, message });
  else if (!signal) body = h(StatusView, { status: "empty", message: "왼쪽 목록에서 이상 신호를 선택하세요." });
  else body = h("div", { class: "detail-body" }, h(SignalReason, { signal }), h(SignalChart, { signal }), h(EvidenceList, { signal, evidence, onPageChange }));
  return h("section", { class: "panel signal-detail", "aria-label": "신호 상세" }, body);
}

// ---------------------------------------------------------------- ⑥ ReviewForm (F-01)
export function ReviewForm({ form, products, submit, disabled, onFieldChange, onSubmit }) {
  const fieldError = (name) => (submit.errors[name] ? h("p", { class: "field-error", role: "alert" }, submit.errors[name]) : null);
  return h(
    "form",
    { class: "panel review-form", novalidate: true, onSubmit },
    h("h2", null, "리뷰 작성"),
    h(
      "div",
      { class: "form-row" },
      h(
        "div",
        { class: "field" },
        h("label", { for: "f-product" }, "상품"),
        h("input", { id: "f-product", name: "product", value: form.product, list: "product-options", placeholder: "예: prod-003", autocomplete: "off", onInput: (e) => onFieldChange("product", e.target.value) }),
        h("datalist", { id: "product-options" }, products.map((p) => h("option", { value: p }))),
        fieldError("product"),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "f-rating" }, "별점"),
        h("select", { id: "f-rating", name: "rating", value: form.rating, onChange: (e) => onFieldChange("rating", e.target.value) }, [5, 4, 3, 2, 1].map((n) => h("option", { value: String(n) }, `${n}점`))),
        fieldError("rating"),
      ),
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "f-text" }, "내용"),
      h("textarea", { id: "f-text", name: "text", rows: 3, value: form.text, placeholder: "리뷰 내용을 입력하세요", onInput: (e) => onFieldChange("text", e.target.value) }),
      fieldError("text"),
    ),
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "submit", class: "btn", disabled }, "등록"),
      submit.message ? h("span", { class: submit.kind === "error" ? "form-message error" : "form-message", role: submit.kind === "error" ? "alert" : "status" }, submit.message) : null,
    ),
  );
}
