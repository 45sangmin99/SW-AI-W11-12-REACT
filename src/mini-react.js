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

  /** 상태 변경 후 다시 렌더링 (P2-07): 새 Virtual DOM 생성 -> Diff -> 바뀐 부분만 Patch 
  update():클래스 안에 정의된 메서드 앞에 function 키워드가 없는게 클래스 메서드 문법 this: 클래스 안에서 지금 이 컴포넌트 객체 자신을 가리킴(내장키워드) 
  */
  update() {
    if (!this.mounted) throw new Error("mount() 전에는 update()할 수 없습니다.")//화면에 처음 생성되어 나타내는 시점;
    if (this.isRendering) throw new Error("렌더링 중에는 상태를 변경할 수 없습니다.");//사용자가 눈으로 볼수있는 실제 웹화면을 그려내는작업
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
//값 저장과 변경. 변경되면 자동으로 다시 그린다. 같은 값(Object.is)이면 무시    첫 렌더링이면 hook을 만들어 저장 → set이 불리면 새 값 계산 → 같은 값이면 무시 → 렌더링 중이면 에러 → 값 갱신 → batch 중이면 dirty에 등록만, 아니면 바로 component.update()로 다시 그림.  

export function useState(initial){
//function useState(initial): 상태 훅을 만드는 함수 정의 반환값:[현재상태값, 상태를 바꾸는 함수] 형태의 배열
  const { component, index } = hookContext("useState");
  // hookContext:지금 렌더링 중인 컴포넌트와 "이 훅이 몇 번째 훅인지"를 알려줌 const { component, index } = ...: 구조 분해 할당 [내장 문법]→ 객체에서 component, index 속성을 꺼내서 같은 이름의 변수로 한 번에 만듦 → const component = 결과.component; const index = 결과.index; 와 같은 뜻
  // "useState" 문자열은 에러 메시지 등에서 어떤 훅인지 표시하려고 넘기는 것으로 추정
  // slot:component.hooks 배열의 index번째 칸에 이미 저장된 훅이 있는지 확인"state"는 그 칸이 state 종류가 맞는지 검사하는 용도
  // 컴포넌트가 다시 렌더링될 때는 이전에 저장해둔 hook이 나오고, 첫 렌더링이면 없음(undefined/null)
  let hook = slot(component, index, "state");
  // !hook: hook이 없으면 true → "첫 렌더링"일 때만 이 안으로 들어감 두번째 렌더링부터는 건너뛰고 저장된 값을 그대로 재사용 = 상태가 유지되는 원리
  if (!hook) {
    hook = { kind: "state", value: typeof initial === "function" ? initial() : initial };
    // 상태를 담을 객체 생성. { kind: 종류표시, value: 현재 상태값 }
    // typeof initial === "function": [내장 연산자] initial의 자료형을 문자열로 알려줌. 함수면 "function"
    // 삼항 연산자 조건 ? A : B: 조건이 참이면 A, 거짓이면 B
    //   → initial이 함수면 initial()을 실행한 결과를 쓰고, 아니면 initial 그대로 씀 (지연 초기화)
    hook.set = (next) => 
    //hook.set에 "상태 변경 함수"를 만들어 붙임. hook 객체에 속성을 새로 추가하는 것
    // (next) => { ... }: 화살표 함수. next는 새 값이거나, 이전 값을 받아 새 값을 돌려주는 함수
    {  // next가 함수면 next(이전값)을 실행한 결과를, 아니면 next 그대로를 새 값으로 씀
      // 예: setCount(c => c + 1) 처럼 이전 값 기반으로 갱신하는 패턴 지원
      const value = typeof next === "function" ? next(hook.value) : next;
      // 값이 그대로면 return으로 함수를 끝냄 → 불필요한 재렌더링 방지
      if (Object.is(value, hook.value)) return;
       // Object.is(a, b): [내장] 두 값이 "같은 값"인지 비교 (===와 거의 같지만 NaN, +0/-0 처리가 다름)
      // 값이 그대로면 return으로 함수를 끝냄 → 불필요한 재렌더링 방지
      if (component.isRendering) throw new Error("렌더링 중에는 setState를 호출할 수 없습니다.");
      // 새 값으로 상태 갱신. 이 줄이 실제로 상태를 바꾸는 부분
      hook.value = value;
      // batchDepth: [직접 만듦] batch(묶음 처리) 안에 있는지 나타내는 숫자 (바깥 파일/모듈 변수)
      //0보다 크면 지금 batch 실행 중이라는 뜻 (중첩될 수 있어서 true/false가 아니라 숫자로 추정)
      // dirty: [직접 만듦] "다시 그려야 하는 컴포넌트" 모음. Set 자료구조로 추정
        // .add(): [내장 - Set 메서드] 값을 추가. Set은 중복을 자동으로 걸러주기 때문에
        //   같은 컴포넌트가 여러 번 들어와도 한 번만 기록됨
      if (batchDepth > 0) {
        dirty.add(component); // batch 안: 값만 바꾸고 렌더링은 batch가 끝날 때 한 번
        return;
      } // batch 밖이면 즉시 컴포넌트를 다시 그림
      // component.update(): [직접 만듦] 렌더링 → diff → patch를 수행하는 메서드로 추정
      component.update(); // 상태가 바뀌면 자동으로 다시 그린다 (P2-11)
    };
    // 완성된 hook을 컴포넌트의 hooks 배열 index번째 칸에 저장
    // 다음 렌더링 때 slot(...)이 이 칸을 읽어서 같은 hook을 돌려줌
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
