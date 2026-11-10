// 고객 문의(VOC) 이상 탐지 페이지의 루트 컴포넌트 (요구사항 4.3.1)
// 상태와 Hook은 여기에만 둔다 (C-01, C-02). 자식 컴포넌트는 props로만 받는다 (C-03 Lifting State Up).
import { h, FunctionComponent, useState, useEffect, useMemo, batch } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { hourRange, filterInquiries, detectAlerts, sinceHour, inPeriod, summarize } from "./analysis.js";
import { paginate } from "./pagination.js";
import { loadDataset, appVersionsOf } from "./data.js";
import { Header, FilterBar, SummaryCard, SignalList, SignalDetail } from "./components.js";

// props: dataUrl(데이터 위치), load(불러오기 함수). load는 테스트에서 바꿔 끼우기 위한 것이고, 기본값이 실제 동작이다
export function App({ dataUrl = "data/inquiries.sample.json", load = loadDataset } = {}) {
  // ---- 필터 (R-03, F-07)
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("all");
  const [category, setCategory] = useState("all");
  const [device, setDevice] = useState("all");
  const [appVersion, setAppVersion] = useState("all");
  // ---- 선택·페이지 (R-02, F-02)
  const [selectedId, setSelectedId] = useState(null);
  const [page, setPage] = useState(1);
  // ---- 데이터와 로딩·오류 상태 (F-03)
  const [inquiries, setInquiries] = useState([]);
  const [meta, setMeta] = useState({});
  const [loadState, setLoadState] = useState({ status: "loading", message: "" });

  // 문의 데이터 불러오기 (Step 1은 공용 샘플 JSON, Step 4에서 문의 서비스 API로 교체)
  useEffect(() => {
    let cancelled = false;
    load(dataUrl)
      .then(({ inquiries: loaded, meta: loadedMeta, skipped }) => {
        if (cancelled) return;
        // 이벤트 밖(Promise 콜백)이므로 직접 batch로 묶어 렌더링을 한 번만 한다
        batch(() => {
          setInquiries(loaded);
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
  const range = useMemo(() => hourRange(inquiries), [inquiries]); // 훑을 시간 범위는 필터와 상관없이 전체 데이터 기준
  // 검색·유형·기기·버전 필터는 탐지 전에 적용한다. 기간 필터는 "평소" 이력을 자르지 않도록 탐지 뒤에 적용한다
  const scoped = useMemo(() => filterInquiries(inquiries, { query, category, device, appVersion }), [inquiries, query, category, device, appVersion]);
  // 한 값만 남긴 필터에서는 그 항목의 쏠림이 100%라서 의미가 없으므로 해당 쏠림은 계산하지 않는다
  const alerts = useMemo(
    () => (range ? detectAlerts(scoped, { ...range, skipCategory: category !== "all", skipDevice: device !== "all", skipVersion: appVersion !== "all" }) : []),
    [scoped, range, category, device, appVersion],
  );
  const since = sinceHour(period, range ? range.to : null);
  const visibleAlerts = useMemo(() => (since === null ? alerts : alerts.filter((a) => a.endHour >= since)), [alerts, since]);
  const summary = useMemo(() => summarize(scoped.filter((q) => inPeriod(q.created_at, since))), [scoped, since]);
  // 선택한 발생 건이 필터로 사라졌으면 첫 발생 건으로 대신한다 (아무것도 선택되지 않은 빈 화면을 피함)
  const selected = visibleAlerts.find((a) => a.id === selectedId) ?? visibleAlerts[0] ?? null;
  const evidence = useMemo(() => paginate(selected ? selected.evidence : [], page, CONFIG.PAGE_SIZE), [selected, page]);
  const appVersions = useMemo(() => appVersionsOf(inquiries), [inquiries]);

  const statusProps = { status: loadState.status, message: loadState.status === "error" ? loadState.message : "" };

  // ---- 이벤트 핸들러: 핸들러 안의 여러 setState는 자동으로 한 번의 렌더링으로 합쳐진다 (Batching)
  const changeFilter = (setter) => (value) => {
    setter(value);
    setPage(1);
  };
  const onReset = () => {
    setQuery("");
    setPeriod("all");
    setCategory("all");
    setDevice("all");
    setAppVersion("all");
    setPage(1);
  };
  const onSelect = (id) => {
    setSelectedId(id);
    setPage(1);
  };

  return h(
    "div",
    { class: "app" },
    h(Header, { isGenerated: meta.generated === true }),
    h(FilterBar, {
      query, period, category, device, appVersion, appVersions,
      onQuery: changeFilter(setQuery), onPeriod: changeFilter(setPeriod), onCategory: changeFilter(setCategory),
      onDevice: changeFilter(setDevice), onVersion: changeFilter(setAppVersion), onReset,
    }),
    h(SummaryCard, { summary, ...statusProps }),
    h(SignalList, { alerts: visibleAlerts, selectedId: selected ? selected.id : null, onSelect, ...statusProps }),
    h(SignalDetail, { alert: selected, evidence, onPageChange: setPage, ...statusProps }),
    loadState.status === "ready" && loadState.message ? h("p", { class: "notice" }, loadState.message) : null,
  );
}

/** 컨테이너에 앱을 붙인다. 만들어진 FunctionComponent를 돌려준다 (테스트에서 상태·변경 목록 확인용) */
export function mountApp(container, props) {
  const component = new FunctionComponent(App, props);
  component.mount(container);
  return component;
}
