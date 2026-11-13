// 고객 문의(VOC) 이상 탐지 페이지 진입점
import { mountApp } from "./app.js";
import { loadStatusHistory, saveStatus } from "./status-api.js";

// 기본은 중계기(tools/dev-proxy.py)를 거쳐 Mini DBMS에서 읽고, 상태 변경도 DB에 저장한다.
// 주소 뒤에 ?source=sample 을 붙이면 DB 없이 예전처럼 샘플 JSON을 읽고, 상태는 화면에만 임시로 둔다 (DB가 꺼져 있을 때 쓰는 비상 수단)
const useSample = new URLSearchParams(location.search).get("source") === "sample";
const props = useSample
  ? { dataUrl: "data/inquiries.sample.json" }
  : {
      dataUrl: "api/inquiries",
      loadHistory: () => loadStatusHistory("api/status-history"),
      saveStatus: (alertId, status) => saveStatus("api/status", alertId, status),
    };
mountApp(document.getElementById("app"), props);
