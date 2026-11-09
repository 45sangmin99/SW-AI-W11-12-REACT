// 리뷰 이상 패턴 탐색 페이지의 루트 컴포넌트 (요구사항 4.3.1)
// 상태와 Hook은 여기에만 둔다 (C-01, C-02). 자식 컴포넌트는 props로만 받는다 (C-03 Lifting State Up).
import { h, FunctionComponent, useState, useEffect, useMemo, batch } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { latestDay, filterReviews, detectSignals, summarize } from "./analysis.js";
import { paginate } from "./pagination.js";
import { validateReview } from "./validate.js";
import { loadDataset, nextId, productIds } from "./data.js";
import { Header, FilterBar, SummaryCard, SignalList, SignalDetail, ReviewForm } from "./components.js";

const INITIAL_FORM = Object.freeze({ product: "", rating: "5", text: "" });
const IDLE = Object.freeze({ kind: "idle", message: "", errors: Object.freeze({}) }); // 같은 객체라서 반복 setState해도 다시 그리지 않는다

// props: dataUrl(데이터 위치), load(불러오기 함수), now(현재 시각 함수). load와 now는 테스트에서 바꿔 끼우기 위한 것이고, 기본값이 실제 동작이다
export function App({ dataUrl = "data/reviews.sample.json", load = loadDataset, now = () => new Date() } = {}) {
  // ---- 필터 (R-03, F-07)
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("all");
  const [rating, setRating] = useState("all");
  // ---- 선택·페이지 (R-02, F-02)
  const [selectedId, setSelectedId] = useState(null);
  const [page, setPage] = useState(1);
  // ---- 데이터와 로딩·오류 상태 (F-03)
  const [reviews, setReviews] = useState([]);
  const [meta, setMeta] = useState({});
  const [loadState, setLoadState] = useState({ status: "loading", message: "" });
  // ---- 새 리뷰 작성 (F-01)
  const [form, setForm] = useState(INITIAL_FORM);
  const [submit, setSubmit] = useState(IDLE);

  // 리뷰 데이터 불러오기 (Step 1은 공용 샘플 JSON, Step 4에서 리뷰 서비스 API로 교체)
  useEffect(() => {
    let cancelled = false;
    load(dataUrl)
      .then(({ reviews: loaded, meta: loadedMeta, skipped }) => {
        if (cancelled) return;
        // 이벤트 밖(Promise 콜백)이므로 직접 batch로 묶어 렌더링을 한 번만 한다
        batch(() => {
          setReviews(loaded);
          setMeta(loadedMeta);
          setLoadState({ status: "ready", message: skipped ? `형식이 올바르지 않은 ${skipped}건은 제외했습니다.` : "" });
        });
      })
      .catch((error) => {
        if (!cancelled) setLoadState({ status: "error", message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 파생 값: 입력이 바뀔 때만 다시 계산한다 (useMemo)
  const baseDay = useMemo(() => latestDay(reviews), [reviews]);
  const filtered = useMemo(() => filterReviews(reviews, { query, period, rating }, baseDay), [reviews, query, period, rating, baseDay]);
  // 평점 필터가 켜져 있으면 "한 평점이 N%"가 당연하므로 평점 쏠림은 계산하지 않는다
  const signals = useMemo(() => detectSignals(filtered, { skipSkew: rating !== "all" }), [filtered, rating]);
  const summary = useMemo(() => summarize(filtered), [filtered]);
  // 선택한 신호가 필터로 사라졌으면 첫 신호로 대신한다 (아무것도 선택되지 않은 빈 화면을 피함)
  const selected = signals.find((s) => s.id === selectedId) ?? signals[0] ?? null;
  const evidence = useMemo(() => paginate(selected ? selected.evidence : [], page, CONFIG.PAGE_SIZE), [selected, page]);
  const products = useMemo(() => productIds(reviews), [reviews]);

  const ready = loadState.status === "ready";
  const statusProps = { status: loadState.status, message: loadState.status === "error" ? loadState.message : "" };

  // ---- 이벤트 핸들러: 핸들러 안의 여러 setState는 자동으로 한 번의 렌더링으로 합쳐진다 (Batching)
  const changeFilter = (setter) => (value) => {
    setter(value);
    setPage(1);
  };
  const onReset = () => {
    setQuery("");
    setPeriod("all");
    setRating("all");
    setPage(1);
  };
  const onSelect = (id) => {
    setSelectedId(id);
    setPage(1);
  };
  const onFieldChange = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
    setSubmit(IDLE); // 다시 입력하기 시작하면 이전 오류·완료 메시지를 지운다
  };
  const onSubmit = (event) => {
    event.preventDefault();
    const result = validateReview(form, new Set(products));
    if (!result.ok) {
      setSubmit({ kind: "error", message: "입력을 확인해 주세요.", errors: result.errors });
      return;
    }
    const review = { id: nextId(reviews), ...result.value, created_at: now().toISOString() };
    setReviews((prev) => [...prev, review]);
    setForm(INITIAL_FORM);
    setSubmit({ kind: "success", message: `리뷰 #${review.id}을(를) 등록했습니다.`, errors: {} });
  };

  return h(
    "div",
    { class: "app" },
    h(Header, { isGenerated: meta.generated === true }),
    h(FilterBar, { query, period, rating, onQuery: changeFilter(setQuery), onPeriod: changeFilter(setPeriod), onRating: changeFilter(setRating), onReset }),
    h(SummaryCard, { summary, ...statusProps }),
    h(
      "main",
      { class: "master-detail" },
      h(SignalList, { signals, selectedId: selected ? selected.id : null, onSelect, ...statusProps }),
      h(SignalDetail, { signal: selected, evidence, onPageChange: setPage, ...statusProps }),
    ),
    h(ReviewForm, { form, products, submit, disabled: !ready, onFieldChange, onSubmit }),
    loadState.status === "ready" && loadState.message ? h("p", { class: "notice" }, loadState.message) : null,
  );
}

/** 컨테이너에 앱을 붙인다. 만들어진 FunctionComponent를 돌려준다 (테스트에서 상태·변경 목록 확인용) */
export function mountApp(container, props) {
  const component = new FunctionComponent(App, props);
  component.mount(container);
  return component;
}
