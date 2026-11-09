// Phase 2: Component · State · Hooks
// 상태가 바뀌면 Phase 1의 Virtual DOM -> Diff -> Patch 흐름을 그대로 사용한다 (P2-30 ~ P2-32).
import { ELEMENT, TEXT, deepFreeze } from "./vdom.js";
import { render, setEventRunner } from "./dom.js";
import { diff } from "./diff.js";
import { patch } from "./patch.js";

// ---------------------------------------------------------------- Batching (O-01)
// batch() 안에서 일어난 setState는 값만 바로 바꾸고, 렌더링은 가장 바깥 batch가 끝날 때 컴포넌트당 한 번만 한다.
//  - 이벤트 핸들러는 자동으로 batch 안에서 실행된다 (아래 setEventRunner).
//  - 타이머·fetch 콜백처럼 이벤트 밖에서는 직접 batch(() => { ... })로 감싼다.
//  - batch 밖의 setState는 예전처럼 즉시 렌더링한다.
let batchDepth = 0;
const dirty = new Set(); // 값이 바뀌었지만 아직 다시 그리지 않은 컴포넌트

export function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushDirty();
  }
}

function flushDirty() {
  const list = [...dirty];
  dirty.clear(); // update() 도중 다시 setState가 와도 이번 목록과 섞이지 않게 먼저 비운다
  let failed = false;
  let firstError;
  for (const component of list) {
    // 한 컴포넌트의 렌더링 에러가 다른 컴포넌트의 갱신을 막지 않게 하고, 첫 에러를 다시 던진다
    try {
      component.update();
    } catch (error) {
      if (!failed) [failed, firstError] = [true, error];
    }
  }
  if (failed) throw firstError;
}

setEventRunner(batch);

// ---------------------------------------------------------------- h()
// 컴포넌트가 Virtual DOM을 반환할 때 쓰는 도우미. 함수형 태그(자식 컴포넌트)는 즉시 호출한다.

let currentComponent = null; // 지금 렌더링 중인 루트 컴포넌트
let childDepth = 0; // 자식 컴포넌트 실행 중이면 > 0 (C-01 ~ C-04)

export function h(tag, props, ...children) {
  if (typeof tag === "function") {
    // 자식 컴포넌트: props만 받는 순수 함수. 이 안에서는 Hook 사용 불가
    childDepth++;
    try {
      return tag({ ...(props ?? {}), children: flatten(children) });
    } finally {
      childDepth--;
    }
  }
  if (tag === "script") return null; // 실행 요소는 렌더링하지 않는다 (U-08)
  return { type: ELEMENT, tag, props: normalizeProps(props), children: toVnodes(children) };
}

function normalizeProps(props) {
  const out = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    const key = name === "className" ? "class" : name;
    out[key] = typeof value === "function" ? value : value === true ? "" : String(value);
  }
  return out;
}

function flatten(list) {
  return list.flatMap((item) => (Array.isArray(item) ? flatten(item) : [item]));
}

function toVnodes(children) {
  const out = [];
  for (const child of flatten(children)) {
    if (child == null || typeof child === "boolean") continue;
    if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
      out.push({ type: TEXT, value: String(child) });
    } else if (isVnode(child)) {
      out.push(child);
    } else {
      // DOM 노드, 함수(호출하지 않은 컴포넌트) 등은 Virtual DOM이 아니다.
      // 받아들이면 freeze가 실패하거나 의도치 않은 참조가 스냅샷에 들어간다
      throw new Error("자식은 문자열·숫자·h()가 만든 노드만 가능합니다.");
    }
  }
  return out;
}

const isPlainObject = (x) => x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;

/** h()가 만드는 형태({type, ...}의 일반 객체)인지 확인 */
function isVnode(x) {
  if (!isPlainObject(x)) return false;
  if (x.type === TEXT) return typeof x.value === "string";
  return x.type === ELEMENT && typeof x.tag === "string" && isPlainObject(x.props) && Array.isArray(x.children);
}

// ---------------------------------------------------------------- FunctionComponent
//hooks 배열(상태 저장), mount()(첫 렌더링), update()(재렌더링)
export class FunctionComponent {
  constructor(fn, props = {}) {
    this.fn = fn;
    this.props = props;
    this.hooks = []; // 상태 저장용 (P2-05): 함수가 다시 실행돼도 값이 유지된다 (P2-24)
    this.hookIndex = 0;
    this.hookCount = null; // 첫 렌더링에서 정해지는 Hook 호출 개수 (이후 렌더링에서 고정)
    this.container = null;
    this.rootEl = null;
    this.vdom = null;
    this.mounted = false;
    this.isRendering = false;
    this.pendingEffects = [];
    this.lastChanges = []; // 가장 최근 update()의 Diff 결과
    // 렌더링 중의 Hook 기록 변경(effect deps, memo 값·deps)은 여기에 임시로 모아 두고,
    // 컴포넌트 함수가 성공한 뒤에만 확정한다. 실패한 렌더는 마지막 정상 렌더의 기록을 건드리지 않는다.
    this.staged = [];
  }

  /** 처음 렌더링 (P2-06) */
  mount(container) {
    if (this.mounted) throw new Error("이미 mount된 컴포넌트입니다.");
    const vdom = this.#renderVdom();
    this.rootEl = render(vdom);
    container.appendChild(this.rootEl);
    this.container = container;
    this.vdom = vdom;
    this.mounted = true;
    this.#runEffects();
  }

  /** 상태 변경 후 다시 렌더링 (P2-07): 새 Virtual DOM 생성 -> Diff -> 바뀐 부분만 Patch */
  update() {
    if (!this.mounted) throw new Error("mount() 전에는 update()할 수 없습니다.");
    if (this.isRendering) throw new Error("렌더링 중에는 상태를 변경할 수 없습니다.");
    const next = this.#renderVdom();
    const changes = diff(this.vdom, next);
    this.rootEl = patch(this.rootEl, changes);
    this.lastChanges = changes; // 마지막 update()에서 만든 변경 목록 (테스트·검증용)
    this.vdom = next;
    this.#runEffects();
  }

  #renderVdom() {
    const prevComponent = currentComponent;
    const prevDepth = childDepth;
    currentComponent = this;
    childDepth = 0;
    this.isRendering = true;
    this.hookIndex = 0;
    this.pendingEffects = [];
    this.staged = [];
    let succeeded = false;
    try {
      const vdom = this.fn(this.props);
      if (!isVnode(vdom) || vdom.type !== ELEMENT) {
        throw new Error("루트 컴포넌트는 하나의 요소를 반환해야 합니다.");
      }
      if (this.hookCount === null) this.hookCount = this.hookIndex;
      else if (this.hookIndex !== this.hookCount) {
        throw new Error("렌더링마다 Hook 호출 개수가 같아야 합니다. 조건문·반복문 안에서 Hook을 호출하지 마세요.");
      }
      // 여기까지 오류가 없었을 때만 Hook 기록을 확정한다 (호출 순서대로)
      for (const commit of this.staged) commit();
      succeeded = true;
      return deepFreeze(vdom);
    } finally {
      this.isRendering = false;
      currentComponent = prevComponent;
      childDepth = prevDepth;
      this.staged = [];
      if (!succeeded) {
        this.pendingEffects = []; // 실패한 렌더의 effect는 실행하지 않는다 (cleanup도 실행하지 않는다)
        if (!this.mounted) {
          // 첫 렌더링이 실패하면 만들다 만 Hook 저장소를 버려서 다시 mount()할 수 있게 한다
          this.hooks = [];
          this.hookCount = null;
        }
      }
    }
  }

  // useEffect는 DOM 반영(Patch)이 끝난 뒤 실행한다. 이전 cleanup을 먼저 호출한다 (U-10)
  #runEffects() {
    const effects = this.pendingEffects;
    this.pendingEffects = [];
    for (const { hook, effect } of effects) {
      if (typeof hook.cleanup === "function") hook.cleanup();
      hook.cleanup = undefined;
      const cleanup = effect();
      if (typeof cleanup === "function") hook.cleanup = cleanup;
    }
  }
}

// ---------------------------------------------------------------- Hooks

/** 루트 컴포넌트 렌더링 중에만 호출 가능 (C-01, C-02) */
function hookContext(name) {
  if (!currentComponent) throw new Error(`${name}은(는) 루트 컴포넌트 렌더링 중에만 호출할 수 있습니다.`);
  if (childDepth > 0) throw new Error(`${name}은(는) 자식 컴포넌트에서 사용할 수 없습니다. props로 전달받으세요.`);
  const component = currentComponent;
  // 첫 렌더링 이후에 Hook이 늘어나면 상태 슬롯이 엉키므로 바로 막는다
  if (component.hookCount !== null && component.hookIndex >= component.hookCount) {
    throw new Error("렌더링마다 Hook 호출 개수가 같아야 합니다. 조건문·반복문 안에서 Hook을 호출하지 마세요.");
  }
  return { component, index: component.hookIndex++ };
}

function slot(component, index, kind) {
  const hook = component.hooks[index];
  if (hook && hook.kind !== kind) throw new Error("렌더링마다 Hook 호출 순서가 같아야 합니다.");
  return hook;
}

// 의존성 비교 규칙: 각 항목을 Object.is로 비교한다 (얕은 비교).
//   deps 생략(undefined) -> 매번 다시 실행/계산
//   deps = []            -> 최초 한 번만
//   deps = [a, b]        -> 항목 중 하나라도 바뀌면
// 렌더링마다 새로 만드는 객체·배열을 deps에 넣으면 매번 "바뀐 것"으로 판단된다.
function depsChanged(prev, next) {
  if (!prev || !next || prev.length !== next.length) return true;
  return next.some((value, i) => !Object.is(value, prev[i]));
}
//값 저장과 변경. 변경되면 자동으로 다시 그린다. 같은 값(Object.is)이면 무시
export function useState(initial) {
  const { component, index } = hookContext("useState");
  let hook = slot(component, index, "state");
  if (!hook) {
    hook = { kind: "state", value: typeof initial === "function" ? initial() : initial };
    hook.set = (next) => {
      const value = typeof next === "function" ? next(hook.value) : next;
      if (Object.is(value, hook.value)) return;
      if (component.isRendering) throw new Error("렌더링 중에는 setState를 호출할 수 없습니다.");
      hook.value = value;
      if (batchDepth > 0) {
        dirty.add(component); // batch 안: 값만 바꾸고 렌더링은 batch가 끝날 때 한 번
        return;
      }
      component.update(); // 상태가 바뀌면 자동으로 다시 그린다 (P2-11)
    };
    component.hooks[index] = hook;
  }
  return [hook.value, hook.set];
}
//DOM 반영 후 실행. 의존성이 바뀌면 이전 cleanup을 먼저 호출한 뒤 실행
export function useEffect(effect, deps) {
  const { component, index } = hookContext("useEffect");
  let hook = slot(component, index, "effect");
  const first = !hook;
  if (first) hook = component.hooks[index] = { kind: "effect", deps: undefined, cleanup: undefined };
  // deps 생략: 매 렌더 후 실행 / []: 최초 한 번 / [a, b]: 값이 바뀔 때
  const shouldRun = first || deps === undefined || depsChanged(hook.deps, deps);
  // deps 기록과 실행 예약은 렌더링이 성공한 뒤에 확정한다.
  // cleanup은 여기서 부르지 않고, 성공한 Patch 뒤 #runEffects에서 새 effect 직전에 호출한다.
  component.staged.push(() => {
    hook.deps = deps;
    if (shouldRun) component.pendingEffects.push({ hook, effect });
  });
}
//	계산 결과 캐시. 의존성이 같으면 재사용
export function useMemo(factory, deps) {
  const { component, index } = hookContext("useMemo");
  const hook = slot(component, index, "memo");
  if (hook && deps !== undefined && !depsChanged(hook.deps, deps)) return hook.value;
  // 계산 결과와 deps는 렌더링이 성공한 뒤에 확정한다 (실패한 렌더의 값이 캐시로 남지 않게)
  const value = factory();
  component.staged.push(() => {
    component.hooks[index] = { kind: "memo", value, deps };
  });
  return value;
}
