// State History (P1-19 ~ P1-21)
// - 경계에서는 이동하지 않는다 (U-04)
// - 과거 상태에서 push하면 현재 위치 뒤의 기록을 버린다 (U-05)
import { deepFreeze } from "./vdom.js";

export class StateHistory {
  #states = [];
  #index = -1;

  constructor(initial) {
    this.push(initial);
  }

  get current() {
    return this.#states[this.#index];
  }
  //1. 경계에서 이동하지 않기
  get canBack() {
    return this.#index > 0;
  }
  get canForward() {
    return this.#index < this.#states.length - 1;
  }
  //2. 과거에서 push하면 미래 버리기
  push(vdom) {
    this.#states.length = this.#index + 1;
    // 저장된 스냅샷은 얼려서 이후 코드가 직접 수정해도 기록이 바뀌지 않게 한다
    this.#states.push(deepFreeze(vdom));
    this.#index++;
  }

  /** 이동에 성공하면 이동한 상태를, 경계면 null을 반환한다 */
  back() { //1. 경계에서 이동하지 않기 처음이면 움직이지않고 Null
    if (!this.canBack) return null;
    return this.#states[--this.#index];
  }
  forward() {//1. 경계에서 이동하지 않기 마지막이면 움직이지않고 Null
    if (!this.canForward) return null;
    return this.#states[++this.#index];
  }
}
