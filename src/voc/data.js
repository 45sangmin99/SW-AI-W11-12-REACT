// 문의 데이터 불러오기·검증 (R-09 스키마, F-03 오류 처리). 순수 함수 + fetch 한 곳.
import { CONFIG } from "./config.js";

const isValidInquiry = (r) =>
  r !== null &&
  typeof r === "object" &&
  Number.isInteger(r.id) &&
  CONFIG.CATEGORIES.includes(r.category) &&
  typeof r.text === "string" &&
  typeof r.app_version === "string" &&
  r.app_version.trim() !== "" &&
  CONFIG.DEVICES.includes(r.device) &&
  typeof r.created_at === "string" &&
  !Number.isNaN(Date.parse(r.created_at));

/**
 * 불러온 JSON을 검증해서 화면이 쓸 수 있는 형태로 만든다.
 * 형식이 틀린 레코드는 건너뛰고 몇 건을 건너뛰었는지 알려준다 (한 건 때문에 화면 전체가 멈추지 않게).
 * 배열 자체가 아니면 에러를 던진다.
 * @param json 배열([...]) 또는 { meta, inquiries }
 * @returns { inquiries, meta, skipped }
 */
export function parseDataset(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.inquiries) ? json.inquiries : null;
  if (!list) throw new Error("문의 데이터 형식이 올바르지 않습니다. (배열 또는 { inquiries: [...] } 이어야 합니다)");
  const inquiries = list.filter(isValidInquiry);
  const meta = !Array.isArray(json) && json.meta && typeof json.meta === "object" ? json.meta : {};
  return { inquiries, meta, skipped: list.length - inquiries.length };
}

/** 공용 샘플 JSON을 가져온다. 네트워크·HTTP·JSON 오류는 사람이 읽을 수 있는 메시지로 바꿔 던진다 */
export async function loadDataset(url, fetchFn = (...args) => fetch(...args)) {
  let response;
  try {
    response = await fetchFn(url);
  } catch {
    throw new Error("문의 데이터를 불러오지 못했습니다. 네트워크 연결이나 서버 실행 여부를 확인해 주세요.");
  }
  if (!response.ok) throw new Error(`문의 데이터를 불러오지 못했습니다. (HTTP ${response.status})`);
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("문의 데이터가 올바른 JSON이 아닙니다.");
  }
  return parseDataset(json);
}

/** 필터 선택지: 데이터에 실제로 있는 앱 버전 (오름차순, "web"은 앱 버전이 아니므로 뺀다) */
export const appVersionsOf = (inquiries) => [...new Set(inquiries.map((q) => q.app_version))].filter((v) => v !== "web").sort();
