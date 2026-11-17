// 고객 문의(VOC) 이상 탐지 페이지의 루트 컴포넌트 (요구사항 4.3.1)
// 상태와 Hook은 여기에만 둔다 (C-01, C-02). 자식 컴포넌트는 props로만 받는다 (C-03 Lifting State Up).
import { h, FunctionComponent, useState, useEffect, useMemo, batch } from "../mini-react.js";
import { CONFIG } from "./config.js";
import { hourRange, filterInquiries, detectAlerts, sinceHour, inPeriod, summarize } from "./analysis.js";
import { paginate } from "./pagination.js";
import { loadDataset, appVersionsOf } from "./data.js";
import { Header, FilterBar, SummaryCard, SignalList, SignalDetail, ProgressPanel } from "./components.js";
import { currentStatus, appendStatus, isUnresolved } from "./status.js";

// props: dataUrl(데이터 위치), load(불러오기 함수), now(상태를 바꾼 시각을 만드는 함수).
// load와 now는 테스트에서 바꿔 끼우기 위한 것이고, 기본값이 실제 동작이다
// loadHistory(저장된 상태 이력 불러오기)와 saveStatus(상태 저장)는 DB에 저장할 때만 넣는다.
// 넣지 않으면(샘플 모드·테스트) 상태는 화면 메모리에만 두고 바로 반영한다.
// api(Step 4)를 넣으면 통합 모드다: 문의 전체를 받지 않고, 필터·탐지·집계·근거 페이지를 서비스 API(/api/v1)가 계산해서 결과만 보낸다.
// 이때 load·loadHistory·saveStatus는 쓰지 않고 api가 대신한다. 샘플 모드(api 없음)는 예전처럼 브라우저에서 계산한다.
// refreshMs(통합 모드 전용)를 넣으면 그 간격(ms)마다 서버에서 다시 받아 새로 접수된 문의가 화면에 반영된다. 0이면 자동 갱신 없음(기본)
export function App({ dataUrl = "data/inquiries.sample.json", load = loadDataset, now = () => new Date().toISOString(), loadHistory, saveStatus: saveStatusProp, api, refreshMs = 0 } = {}) {
  const saveStatus = api ? api.saveStatus : saveStatusProp;
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
    if (api) return undefined; // 통합 모드는 아래 서비스 API 효과가 대신한다
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

  // ---- 통합 모드 (Step 4): 서비스 API가 계산한 결과를 받아 온다. 조건이 바뀔 때마다 다시 요청한다 (서버가 Redis 캐시로 답할 수 있다)
  const filters = { query, period, category, device, appVersion };
  const [remote, setRemote] = useState({ status: "loading", message: "", overview: null, cards: [], counts: null, served: null });
  const [detail, setDetail] = useState({ id: null, alert: null, evidence: { items: [], page: 1, totalPages: 1, total: 0 } });
  const [remoteHistory, setRemoteHistory] = useState({ id: null, rows: [] });
  const [reloadTick, setReloadTick] = useState(0); // 상태를 저장한 뒤 목록·이력을 다시 받으려고 올린다
  // 자동 갱신: 일정 간격마다 같은 요청을 다시 보낸다 (탭이 가려져 있으면 건너뛴다). 서버는 바뀐 게 없으면 Redis 캐시로 빠르게 답한다
  useEffect(() => {
    if (!api || !refreshMs) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) setReloadTick((n) => n + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [api, refreshMs]);
  // 신호 목록: 조건(필터·진행 현황)이 바뀌거나 상태를 저장하거나 자동 갱신 시각이 되면 다시 받는다. 오래된 요청의 응답은 버린다
  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    Promise.all([api.overview(filters), api.alerts(filters, { status: statusFilter, page: 1, pageSize: 200 })])
      .then(([overview, list]) => {
        if (cancelled) return;
        batch(() => {
          setRemote({ status: "ready", message: "", overview: overview.body, cards: list.body.alerts, counts: list.body.counts ?? null, served: { from: list.body.dataSource, ms: list.ms } });
        });
      })
      .catch((error) => {
        if (!cancelled) setRemote((r) => ({ ...r, status: "error", message: error.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [api, query, period, category, device, appVersion, statusFilter, reloadTick]);
  const remoteSelectedId = (remote.cards.find((c) => c.id === selectedId) ?? remote.cards[0])?.id ?? null;
  // 선택한 신호의 상세(이유·차트·근거 한 페이지)와 상태 이력
  useEffect(() => {
    if (!api || remoteSelectedId === null) return undefined;
    let cancelled = false;
    api
      .detail(remoteSelectedId, filters, page)
      .then(({ body }) => {
        if (!cancelled) setDetail({ id: remoteSelectedId, alert: body.alert, evidence: body.evidence });
      })
      .catch((error) => {
        if (!cancelled) setRemote((r) => ({ ...r, status: "error", message: error.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [api, remoteSelectedId, page, query, period, category, device, appVersion, reloadTick]);
  useEffect(() => {
    if (!api || remoteSelectedId === null) return undefined;
    let cancelled = false;
    api
      .history(remoteSelectedId)
      .then(({ body }) => {
        if (!cancelled) setRemoteHistory({ id: remoteSelectedId, rows: body.history });
      })
      .catch((error) => {
        if (!cancelled) setRemote((r) => ({ ...r, status: "error", message: error.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [api, remoteSelectedId, reloadTick]);

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
  const alertsInPeriod = useMemo(() => alerts.filter((a) => since === null || a.endHour >= since), [alerts, since]);
  const visibleAlerts = useMemo(
    () => alertsInPeriod.filter((a) => statusFilter === "all" || currentStatus(statusLog[a.id]) === statusFilter),
    [alertsInPeriod, statusFilter, statusLog],
  );
  // 미해결 신호 수: 진행 현황 필터를 걸기 전의 신호 중 아직 "해결"이 아닌 것 (필터를 바꿔도 숫자는 그대로)
  const alertCounts = useMemo(
    () => ({ all: alertsInPeriod.length, unresolved: alertsInPeriod.filter((a) => isUnresolved(currentStatus(statusLog[a.id]))).length }),
    [alertsInPeriod, statusLog],
  );
  const summary = useMemo(() => summarize(scoped.filter((q) => inPeriod(q.created_at, since))), [scoped, since]);
  // 선택한 발생 건이 필터로 사라졌으면 첫 발생 건으로 대신한다 (아무것도 선택되지 않은 빈 화면을 피함)
  const selected = visibleAlerts.find((a) => a.id === selectedId) ?? visibleAlerts[0] ?? null;
  const evidence = useMemo(() => paginate(selected ? selected.evidence : [], page, CONFIG.PAGE_SIZE), [selected, page]);
  const appVersions = useMemo(() => appVersionsOf(inquiries), [inquiries]);
  // 카드에 보여줄 현재 상태: 이력이 바뀔 때만 다시 만든다
  const statusOf = useMemo(() => Object.fromEntries(Object.entries(statusLog).map(([id, history]) => [id, currentStatus(history)])), [statusLog]);

  // 통합 모드의 화면에 쓸 값 (같은 컴포넌트가 로컬 계산 결과와 서비스 응답을 똑같이 받는다)
  const detailReady = api ? detail.id === remoteSelectedId && detail.alert !== null : true;
  const view = api
    ? {
        summary: remote.overview ? { count: remote.overview.total, topCategory: remote.overview.topCategory, topCount: remote.overview.topCount } : { count: 0, topCategory: null, topCount: 0 },
        appVersions: remote.overview?.appVersions ?? [],
        alerts: remote.cards,
        alertCounts: remote.counts,
        selected: detailReady ? detail.alert : null,
        selectedId: remoteSelectedId,
        evidence: detail.evidence,
        statusOf: Object.fromEntries(remote.cards.map((c) => [c.id, c.currentStatus])),
        history: remoteHistory.id === remoteSelectedId ? remoteHistory.rows : [],
        loadState: { status: remote.status, message: remote.message },
        meta: { generated: remote.overview?.meta?.generated === true, served: remote.served ? { from: remote.served.from, ms: remote.served.ms } : undefined },
      }
    : { summary, appVersions, alerts: visibleAlerts, alertCounts, selected, selectedId: selected ? selected.id : null, evidence, statusOf, history: selected ? (statusLog[selected.id] ?? []) : [], loadState, meta };
  const statusProps = { status: view.loadState.status, message: view.loadState.status === "error" ? view.loadState.message : "" };
  // 상세만 아직 오는 중이면(신호를 바꾼 직후) 상세 영역에만 로딩을 보인다
  const detailStatusProps = api && view.loadState.status === "ready" && !detailReady && view.selectedId !== null ? { status: "loading", message: "" } : statusProps;

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
    const nowStatus = api ? (remote.cards.find((c) => c.id === alertId)?.currentStatus ?? currentStatus()) : currentStatus(statusLog[alertId]);
    if (saveState.saving || status === nowStatus) return;
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
          // 통합 모드는 목록과 이력을 서비스에서 다시 받는다 (서비스가 저장 확인 뒤에 캐시를 비웠다). 그 전까지는 화면을 바꾸지 않는다
          if (api) setReloadTick((n) => n + 1);
          else setStatusLog((log) => ({ ...log, [alertId]: appendStatus(log[alertId], saved.status, saved.at) }));
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
    h(Header, { isGenerated: view.meta.generated === true, served: view.meta.served, refreshSeconds: api && refreshMs ? Number((refreshMs / 1000).toFixed(2)) : 0 }),
    h(FilterBar, {
      query, period, category, device, appVersion, appVersions: view.appVersions, statusFilter,
      onQuery: changeFilter(setQuery), onPeriod: changeFilter(setPeriod), onCategory: changeFilter(setCategory),
      onDevice: changeFilter(setDevice), onVersion: changeFilter(setAppVersion), onStatusFilter: changeFilter(setStatusFilter), onReset,
    }),
    h(SummaryCard, { summary: view.summary, alertCounts: view.alertCounts, ...statusProps }),
    h(SignalList, { alerts: view.alerts, selectedId: view.selectedId, onSelect, statusOf: view.statusOf, ...statusProps }),
    h(SignalDetail, { alert: view.selected, evidence: view.evidence, onPageChange: setPage, ...detailStatusProps }),
    view.loadState.status === "ready" && view.selectedId !== null
      ? h(ProgressPanel, {
          alertId: view.selectedId,
          currentStatus: currentStatus(view.history),
          history: view.history,
          onStatusChange,
          persisted: Boolean(saveStatus),
          saving: saveState.saving,
          notice: saveState.alertId === view.selectedId ? saveState.message : "",
        })
      : null,
    view.loadState.status === "ready" && view.loadState.message ? h("p", { class: "notice" }, view.loadState.message) : null,
  );
}

/** 컨테이너에 앱을 붙인다. 만들어진 FunctionComponent를 돌려준다 (테스트에서 상태·변경 목록 확인용) */
export function mountApp(container, props) {
  const component = new FunctionComponent(App, props);
  component.mount(container);
  return component;
}
