// VOC 서비스 API(/api/v1)를 부르는 클라이언트 (Step 4). 순수 함수 + fetch 한 곳.
// fetchFn은 테스트에서 바꿔 끼운다 (data.js의 loadDataset, status-api.js와 같은 방식).
// 모든 조회 함수는 { body, ms }를 돌려준다. body.dataSource("redis" | "dbms")는 서버가 어디서 읽었는지, ms는 응답이 오기까지 걸린 시간이다.
import { saveStatus as saveStatusRequest } from "./status-api.js";

/** 조회 실패. status가 0이면 서버에 닿지 못한 것이다 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};
const reasonOf = (body) => (typeof body?.error === "string" ? ` ${body.error}` : "");

/** 조건을 쿼리 문자열로. "all"과 빈 값은 보내지 않는다 (서버의 기본값이 전체) */
export function toQuery(filters = {}, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value === undefined || value === null || value === "" || value === "all") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function createServiceApi(base = "api/v1", fetchFn = (...args) => fetch(...args)) {
  async function get(path) {
    const startedAt = performance.now();
    let response;
    try {
      response = await fetchFn(`${base}${path}`);
    } catch {
      throw new ApiError("서버에 연결하지 못했습니다. 네트워크 연결이나 서버 실행 여부를 확인해 주세요.", 0);
    }
    const body = await readJson(response);
    if (!response.ok) throw new ApiError(`데이터를 불러오지 못했습니다. (HTTP ${response.status})${reasonOf(body)}`, response.status);
    if (body === null) throw new ApiError("서버 응답이 올바른 JSON이 아닙니다.", response.status);
    return { body, ms: Math.round(performance.now() - startedAt) };
  }

  return {
    overview: (filters) => get(`/overview?${toQuery(filters)}`),
    alerts: (filters, { status, page, pageSize } = {}) => get(`/alerts?${toQuery(filters, { status, page, pageSize })}`),
    detail: (id, filters, evidencePage) => get(`/alerts/${encodeURIComponent(id)}?${toQuery(filters, { evidencePage })}`),
    history: (id) => get(`/alerts/${encodeURIComponent(id)}/status-history`),

    /**
     * 상태를 저장하고 확인을 기다린다. 저장되면 { status, at }. 실패는 SaveError (outcome: not_saved | unknown).
     * 저장 결과의 구분 규칙(요청 거절은 저장 안 됨, 서버 오류와 연결 끊김은 모름)은 status-api.js 한 곳에 있다.
     * 본문에 alertId가 같이 가지만 서비스는 주소의 ID만 쓴다.
     */
    saveStatus: (id, status) => saveStatusRequest(`${base}/alerts/${encodeURIComponent(id)}/status`, id, status, fetchFn),
  };
}
