// 이상 신호의 진행 상태 (정의서 F-08, C10, R-14) — 순수 함수 모음
// Step 1 임시 버전: 이력은 App의 상태(메모리)에만 있다. Step 4에서는 저장 위치가 Mini DBMS의
// alert_status_history 테이블로 바뀌지만, 아래 함수들의 규칙(이력은 새 행만 추가, 최신 행이 현재 상태)은 그대로다.
import { CONFIG } from "./config.js";

export const STATUSES = CONFIG.STATUSES;
export const DEFAULT_STATUS = CONFIG.STATUSES[0];

/** 현재 상태 = 이력의 가장 마지막 행의 상태. 이력이 없으면 기본 상태 (R-14: 조회 시 최신 행을 고른다) */
export const currentStatus = (history = []) => (history.length ? history[history.length - 1].status : DEFAULT_STATUS);

/** 상태가 바뀔 때마다 이전 행은 그대로 두고 새 행만 뒤에 붙인다 (R-14). 원래 배열은 건드리지 않는다 */
export const appendStatus = (history = [], status, at) => [...history, { status, at }];

/**
 * 지금 상태(from)에서 to로 바꿀 수 있는가.
 * 정의서는 "다섯 단계 중에서 변경한다"고만 하고 되돌리기 허용 여부는 정하지 않았다 (정의서에 없어서 정한 값, 사용자 결정).
 * 결정: 같은 상태만 빼고 어느 단계로든 바꿀 수 있다. 잘못 눌렀을 때 복구할 수 없는 것이 더 나쁘고,
 * 되돌려도 이력에 새 행으로 남으므로 기록은 지워지지 않는다 (R-14).
 */
export function canChangeTo(from, to) {
  return from !== to;
}
