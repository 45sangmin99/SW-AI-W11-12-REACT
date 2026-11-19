// 신호 진행 상태의 불러오기·저장 (F-08, R-14). 중계기(tools/dev-proxy.py)와 주고받는다.
// 순수 함수 + fetch 한 곳. fetchFn은 테스트에서 바꿔 끼운다 (data.js의 loadDataset과 같은 방식).
import { CONFIG } from "./config.js";

/**
 * 저장 실패. outcome으로 두 경우를 구분한다.
 *   "not_saved"  저장되지 않았다. 상태는 그대로이고 다시 시도해도 된다
 *   "unknown"    저장됐는지 알 수 없다. 다시 보내면 같은 상태가 두 번 저장될 수 있다
 */
export class SaveError extends Error {
  constructor(message, outcome) {
    super(message);
    this.outcome = outcome;
  }
}

// 응답 본문을 JSON으로 읽는다. 본문이 없거나 JSON이 아니면 null (호출하는 쪽이 상태 코드로 판단한다)
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const reasonOf = (body) => (typeof body?.error === "string" ? ` ${body.error}` : "");

// { 신호 ID: [{ status, at }, ...] } 모양인지 확인한다. 상태 이름은 CONFIG.STATUSES 안에 있어야 한다
const isHistory = (history) =>
  history !== null &&
  typeof history === "object" &&
  !Array.isArray(history) &&
  Object.values(history).every(
    (rows) => Array.isArray(rows) && rows.every((row) => row && CONFIG.STATUSES.includes(row.status) && typeof row.at === "string"),
  );

/** 저장된 상태 이력 전체를 가져온다. 실패는 사람이 읽을 수 있는 메시지로 바꿔 던진다 */
export async function loadStatusHistory(url, fetchFn = (...args) => fetch(...args)) {
  let response;
  try {
    response = await fetchFn(url);
  } catch {
    throw new Error("진행 상태를 불러오지 못했습니다. 네트워크 연결이나 서버 실행 여부를 확인해 주세요.");
  }
  const body = await readJson(response);
  if (!response.ok) throw new Error(`진행 상태를 불러오지 못했습니다. (HTTP ${response.status})${reasonOf(body)}`);
  if (!isHistory(body?.history)) throw new Error("진행 상태 데이터 형식이 올바르지 않습니다.");
  return body.history;
}

/**
 * 신호의 상태를 바꾸고 저장 확인을 기다린다. 저장되면 { status, at }(at은 서버가 찍은 시각)을 돌려준다.
 * 실패하면 SaveError를 던진다. 결과를 알 수 없을 때는 항상 "unknown"으로 다룬다 (저장됐을 수 있으므로)
 */
export async function saveStatus(url, alertId, status, fetchFn = (...args) => fetch(...args)) {
  let response;
  try {
    response = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ alertId, status }) });
  } catch {
    // 요청이 서버에 닿았는지 알 수 없다
    throw new SaveError("서버와 연결이 끊어졌습니다.", "unknown");
  }
  const body = await readJson(response);
  if (response.ok) {
    if (typeof body?.status !== "string" || typeof body?.at !== "string") throw new SaveError("저장 응답의 형식이 올바르지 않습니다.", "unknown");
    return { status: body.status, at: body.at };
  }
  // 서버가 outcome을 알려 주면 그대로 따른다. 없으면 서버 오류(5xx)는 모름, 요청 거절(4xx)은 저장 안 됨으로 본다
  const outcome = body?.outcome === "unknown" || body?.outcome === "not_saved" ? body.outcome : response.status >= 500 ? "unknown" : "not_saved";
  throw new SaveError(typeof body?.error === "string" ? body.error : `저장하지 못했습니다. (HTTP ${response.status})`, outcome);
}
