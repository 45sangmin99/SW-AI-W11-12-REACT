// 고객 문의(VOC) 이상 탐지 페이지의 루트 컴포넌트 (요구사항 4.3.1)
// 상태와 Hook은 여기에만 둔다 (C-01, C-02). 자식 컴포넌트는 props로만 받는다 (C-03 Lifting State Up).
import { h, FunctionComponent, useState, useEffect, useMemo, batch } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { hourRange, filterInquiries, detectAlerts, sinceHour, inPeriod, summarize } from "./analysis.js";
import { paginate } from "./pagination.js";
import { loadDataset, appVersionsOf } from "./data.js";
import { Header, FilterBar, SummaryCard, SignalList, SignalDetail, ProgressPanel } from "./components.js";
import { currentStatus, appendStatus } from "./status.js";

// props: dataUrl(데이터 위치), load(불러오기 함수), now(상태를 바꾼 시각을 만드는 함수).
// load와 now는 테스트에서 바꿔 끼우기 위한 것이고, 기본값이 실제 동작이다
// loadHistory(저장된 상태 이력 불러오기)와 saveStatus(상태 저장)는 DB에 저장할 때만 넣는다.
// 넣지 않으면(샘플 모드·테스트) 상태는 화면 메모리에만 두고 바로 반영한다
export function App({ dataUrl = "data/inquiries.sample.json", load = loadDataset, now = () => new Date().toISOString(), loadHistory, saveStatus } = {}) {
  // ---- 필터 (R-03, F-07)
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState("all");
  const [category, setCategory] = useState("all");
  const [device, setDevice] = useState("all");
  const [appVersion, setAppVersion] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all"); // 진행 현황 필터: 탐지가 끝난 신호를 상태별로 모아 본다 (F-08)
  // ---- 선택·페이지 (R-02, F-02)
  const [selectedId, setSelectedId] = useState(null);
  const [page, setPage] = useState(1);
  // ---- 데이터와 로딩·오류 상태 (F-03)
  const [inquiries, setInquiries] = useState([]);
  const [meta, setMeta] = useState({});
  const [loadState, setLoadState] = useState({ status: "loading", message: "" });
  // ---- 신호 진행 상태 이력 (F-08, R-14, Step 1 임시 버전): { 신호 ID: [{ status, at }, ...] }. 이력은 새 행만 추가한다
  const [statusLog, setStatusLog] = useState({});
  // ---- 저장 요청의 진행·결과: 저장 중에는 버튼을 잠그고(같은 상태가 두 번 저장되는 것을 막는다), 실패하면 이유를 보여준다
  const [saveState, setSaveState] = useState({ saving: false, message: "", alertId: null });

  // 문의 데이터 불러오기 (Step 1은 공용 샘플 JSON, Step 4에서 문의 서비스 API로 교체)
  useEffect(() => {
    let cancelled = false;
    // 문의와 저장된 상태 이력을 함께 불러온다. 하나라도 실패하면 오류 화면이다
    // (이력 없이 보여주면 DB에 이력이 있는데도 모두 "확인 필요"로 보이는 거짓 화면이 된다)
    Promise.all([load(dataUrl), loadHistory ? loadHistory() : null])
      .then(([{ inquiries: loaded, meta: loadedMeta, skipped }, history]) => {
        if (cancelled) return;
        // 이벤트 밖(Promise 콜백)이므로 직접 batch로 묶어 렌더링을 한 번만 한다
        batch(() => {
          setInquiries(loaded);
          setMeta(loadedMeta);
          if (history) setStatusLog(history);
          setLoadState({ status: "ready", message: skipped ? `형식이 올바르지 않은 ${skipped}건은 제외했습니다` : "" });
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
  // 기간 필터와 진행 현황 필터는 둘 다 탐지가 끝난 뒤에 적용한다 (탐지 계산이나 "평소" 이력에는 영향이 없다)
  const visibleAlerts = useMemo(
    () => alerts.filter((a) => (since === null || a.endHour >= since) && (statusFilter === "all" || currentStatus(statusLog[a.id]) === statusFilter)),
    [alerts, since, statusFilter, statusLog],
  );
  const summary = useMemo(() => summarize(scoped.filter((q) => inPeriod(q.created_at, since))), [scoped, since]);
  // 선택한 발생 건이 필터로 사라졌으면 첫 발생 건으로 대신한다 (아무것도 선택되지 않은 빈 화면을 피함)
  const selected = visibleAlerts.find((a) => a.id === selectedId) ?? visibleAlerts[0] ?? null;
  const evidence = useMemo(() => paginate(selected ? selected.evidence : [], page, CONFIG.PAGE_SIZE), [selected, page]);
  const appVersions = useMemo(() => appVersionsOf(inquiries), [inquiries]);
  // 카드에 보여줄 현재 상태: 이력이 바뀔 때만 다시 만든다
  const statusOf = useMemo(() => Object.fromEntries(Object.entries(statusLog).map(([id, history]) => [id, currentStatus(history)])), [statusLog]);

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
    setStatusFilter("all");
    setPage(1);
  };
  const onSelect = (id) => {
    setSelectedId(id);
    setPage(1);
  };
  // 같은 상태로의 변경은 이력에 행을 만들지 않는다 (U-06과 같은 이유: 바뀐 게 없으면 기록하지 않는다)
  const onStatusChange = (alertId, status) => {
    if (saveState.saving || status === currentStatus(statusLog[alertId])) return;
    if (!saveStatus) {
      // 저장소가 없다 (샘플 모드·테스트): 화면에만 바로 반영한다
      setStatusLog((log) => ({ ...log, [alertId]: appendStatus(log[alertId], status, now()) }));
      return;
    }
    // 저장이 확인된 뒤에만 화면(이력)을 바꾼다. 시각은 서버가 찍은 값을 쓴다
    setSaveState({ saving: true, message: "", alertId });
    saveStatus(alertId, status).then(
      (saved) =>
        batch(() => {
          setStatusLog((log) => ({ ...log, [alertId]: appendStatus(log[alertId], saved.status, saved.at) }));
          setSaveState({ saving: false, message: "", alertId });
        }),
      (error) => {
        // 저장 안 됨: 상태는 그대로이니 다시 눌러도 된다. 모름(그 밖의 오류 포함): 저장됐을 수 있어 확인을 안내한다
        const message =
          error.outcome === "not_saved"
            ? `저장되지 않았습니다 · ${error.message}`
            : `저장 여부를 알 수 없습니다 · ${error.message} 새로고침해서 이력을 확인한 뒤 다시 시도해 주세요`;
        setSaveState({ saving: false, message, alertId });
      },
    );
  };

  return h(
    "div",
    { class: "app" },
    h(Header, { isGenerated: meta.generated === true }),
    h(FilterBar, {
      query, period, category, device, appVersion, appVersions, statusFilter,
      onQuery: changeFilter(setQuery), onPeriod: changeFilter(setPeriod), onCategory: changeFilter(setCategory),
      onDevice: changeFilter(setDevice), onVersion: changeFilter(setAppVersion), onStatusFilter: changeFilter(setStatusFilter), onReset,
    }),
    h(SummaryCard, { summary, ...statusProps }),
    h(SignalList, { alerts: visibleAlerts, selectedId: selected ? selected.id : null, onSelect, statusOf, ...statusProps }),
    h(SignalDetail, { alert: selected, evidence, onPageChange: setPage, ...statusProps }),
    loadState.status === "ready" && selected
      ? h(ProgressPanel, {
          alertId: selected.id,
          currentStatus: currentStatus(statusLog[selected.id]),
          history: statusLog[selected.id] ?? [],
          onStatusChange,
          persisted: Boolean(saveStatus),
          saving: saveState.saving,
          notice: saveState.alertId === selected.id ? saveState.message : "",
        })
      : null,
    loadState.status === "ready" && loadState.message ? h("p", { class: "notice" }, loadState.message) : null,
  );
}

/** 컨테이너에 앱을 붙인다. 만들어진 FunctionComponent를 돌려준다 (테스트에서 상태·변경 목록 확인용) */
export function mountApp(container, props) {
  const component = new FunctionComponent(App, props);
  component.mount(container);
  return component;
}
