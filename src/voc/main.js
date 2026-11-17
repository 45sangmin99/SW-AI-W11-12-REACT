// 고객 문의(VOC) 이상 탐지 페이지 진입점
import { mountApp } from "./app.js";
import { createServiceApi } from "./service-api.js";

// 기본(통합 모드)은 VOC 서비스 API(/api/v1)를 부른다. 문의를 DBMS(필요하면 Redis 캐시)에서 읽어 서버가 탐지·집계하고,
// 화면은 조건을 보내 결과만 받는다. 상태 변경도 서비스를 거쳐 DBMS에 저장된다 (tools/voc-service.mjs)
// 주소 뒤에 ?source=sample 을 붙이면 서버 없이 예전처럼 샘플 JSON을 읽어 브라우저에서 계산하고, 상태는 화면에만 임시로 둔다
const useSample = new URLSearchParams(location.search).get("source") === "sample";
// 통합 모드는 10초마다 자동으로 다시 받는다. ?refresh=초 로 바꿀 수 있고 0이면 끈다 (시험·시연용)
const refreshParam = new URLSearchParams(location.search).get("refresh");
const refreshSeconds = /^\d{1,3}$/.test(refreshParam ?? "") ? Number(refreshParam) : 10;
const props = useSample ? { dataUrl: "data/inquiries.sample.json" } : { api: createServiceApi("api/v1"), refreshMs: refreshSeconds * 1000 };
mountApp(document.getElementById("app"), props);
