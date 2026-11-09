// 리뷰 데이터 불러오기·검증 (R-09 스키마, F-03 오류 처리). 순수 함수 + fetch 한 곳.
import { CONFIG } from "./config.js";

const isValidReview = (r) =>
  r !== null &&
  typeof r === "object" &&
  Number.isInteger(r.id) &&
  typeof r.product_id === "string" &&
  r.product_id.trim() !== "" &&
  Number.isInteger(r.rating) &&
  r.rating >= CONFIG.RATING_MIN &&
  r.rating <= CONFIG.RATING_MAX &&
  typeof r.text === "string" &&
  typeof r.created_at === "string" &&
  !Number.isNaN(Date.parse(r.created_at));

/**
 * 불러온 JSON을 검증해서 화면이 쓸 수 있는 형태로 만든다.
 * 형식이 틀린 레코드는 건너뛰고 몇 건을 건너뛰었는지 알려준다 (한 건 때문에 화면 전체가 멈추지 않게).
 * 배열 자체가 아니면 에러를 던진다.
 * @param json 배열([...]) 또는 { meta, reviews }
 * @returns { reviews, meta, skipped }
 */
export function parseDataset(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.reviews) ? json.reviews : null;
  if (!list) throw new Error("리뷰 데이터 형식이 올바르지 않습니다. (배열 또는 { reviews: [...] } 이어야 합니다)");
  const reviews = list.filter(isValidReview);
  const meta = !Array.isArray(json) && json.meta && typeof json.meta === "object" ? json.meta : {};
  return { reviews, meta, skipped: list.length - reviews.length };
}

/** 공용 샘플 JSON을 가져온다. 네트워크·HTTP·JSON 오류는 사람이 읽을 수 있는 메시지로 바꿔 던진다 */
export async function loadDataset(url, fetchFn = (...args) => fetch(...args)) {
  let response;
  try {
    response = await fetchFn(url);
  } catch {
    throw new Error("리뷰 데이터를 불러오지 못했습니다. 네트워크 연결이나 서버 실행 여부를 확인해 주세요.");
  }
  if (!response.ok) throw new Error(`리뷰 데이터를 불러오지 못했습니다. (HTTP ${response.status})`);
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("리뷰 데이터가 올바른 JSON이 아닙니다.");
  }
  return parseDataset(json);
}

/** DBMS가 자동 부여하는 id를 흉내낸다: 가장 큰 id + 1 (Step 4에서 DBMS가 대신 부여) */
export const nextId = (reviews) => reviews.reduce((max, r) => Math.max(max, r.id), 0) + 1;

export const productIds = (reviews) => [...new Set(reviews.map((r) => r.product_id))].sort();
