# Mini React

바닐라 JavaScript(ES Modules)로 직접 구현한 미니 리액트. 외부 라이브러리와 프레임워크를 쓰지 않았다.

> **한 줄 요약**: `h()`로 Virtual DOM을 만들고 → 이전 것과 비교(`diff`)하고 → 바뀐 노드만 실제 DOM에 반영(`patch`)한다.
> 상태(`useState`)가 바뀌면 이 과정이 자동으로 다시 돈다.

## 구현 범위

| 단계 | 내용 | 파일 |
| --- | --- | --- |
| **Phase 1** | Virtual DOM 변환 · Diff 알고리즘 · Patch · State History | `src/vdom.js` `diff.js` `patch.js` `dom.js` `history.js` |
| **Phase 1 검증 페이지** | 실제 영역 + 테스트 영역 + Patch/뒤로가기/앞으로가기 | `index.html`, `src/main.js` |
| **Phase 2** | 함수형 컴포넌트 · State · Hooks (`useState` `useEffect` `useMemo`) | `src/mini-react.js` |
| **단위 테스트** | 직접 만든 테스트 러너 + 121개 테스트 | `test.html`, `tests/` |

Phase 2는 Phase 1의 `diff`·`patch`·`render`를 **그대로 재사용**한다. 상태가 바뀌면 새 Virtual DOM 생성 → Diff → 바뀐 부분만 Patch 순서로 처리된다.

## 빠른 시작

모듈(`import`)을 쓰기 때문에 파일을 더블클릭(`file://`)하면 동작하지 않는다. 로컬 서버로 연다.

```bash
python3 -m http.server 8000
```

| 주소 | 내용 |
| --- | --- |
| `http://localhost:8000/index.html` | Phase 1 검증 페이지 |
| `http://localhost:8000/test.html` | 단위 테스트 (121개) |

### Phase 1 검증 페이지 사용법
1. 오른쪽 **코드 칸**의 HTML을 고치면 **테스트 영역** 미리보기가 바뀐다 (실제 영역은 그대로).
2. **Patch**를 누르면 변경된 부분만 **실제 영역**에 반영된다.
3. **뒤로가기 / 앞으로가기**는 실제 영역과 테스트 영역을 함께 이전·다음 상태로 되돌린다.

### Phase 2 사용 예시
```js
import { h, FunctionComponent, useState, useEffect, useMemo } from "./src/mini-react.js";

// 자식 컴포넌트: props만 받는 순수 함수 (Hook 사용 불가)
function Counter({ label, count, onAdd }) {
  return h("button", { onClick: onAdd }, label, ": ", count);
}

// 루트 컴포넌트: 상태와 Hook은 여기에만
function App() {
  const [count, setCount] = useState(0);
  const double = useMemo(() => count * 2, [count]);
  useEffect(() => { document.title = "count=" + count; }, [count]);

  return h("div", null,
    h(Counter, { label: "클릭", count, onAdd: () => setCount(count + 1) }),
    h("p", null, "두 배: ", double));
}

new FunctionComponent(App).mount(document.getElementById("app"));
```
버튼을 두 번 누르면 `클릭: 2`, `두 배: 4`가 되고, `<button>`은 같은 DOM 노드로 유지된다 (실행해서 확인함).

## 핵심 기능

### Virtual DOM
- 요소 `{ type: "element", tag, props, children }`, 텍스트 `{ type: "text", value }`
- 공백 텍스트는 보존하고, 주석과 `<script>`는 제외한다.
- `<template>`은 `template.content`의 내용을 자식으로 다룬다.
- 저장된 Virtual DOM은 `deepFreeze`로 불변이다. 직접 수정하면 에러가 난다.

### Diff (`diff.js`)
두 Virtual DOM을 같은 위치끼리 비교해 **변경 목록**을 만든다. DOM은 건드리지 않는다.

| 변경 | 의미 |
| --- | --- |
| `CREATE` | 노드 추가 |
| `REMOVE` | 노드 삭제 |
| `REPLACE` | 타입(태그/종류) 교체 |
| `UPDATE_PROPS` | 속성 변경 |
| `UPDATE_TEXT` | 텍스트 변경 |

각 변경은 `path`(루트부터의 자식 인덱스 배열)를 가진다. 자식은 key 없이 **인덱스 순서**로 비교한다.

### Patch (`patch.js`)
변경 목록의 노드만 실제 DOM에서 찾아 고친다. **변경되지 않은 노드는 같은 DOM 노드로 유지된다** (포커스·입력 중인 값 보존).

### State History (`history.js`)
- 처음에서 뒤로가기, 마지막에서 앞으로가기는 이동하지 않는다 (버튼 비활성화).
- 변경 없는 Patch는 기록을 추가하지 않는다.
- 과거 상태로 간 뒤 Patch하면 이후(미래) 기록을 버린다.

### Component · State · Hooks (`mini-react.js`)
| 기능 | 설명 |
| --- | --- |
| `h(tag, props, ...children)` | Virtual DOM을 만든다 (React의 `createElement`에 해당). JSX 변환기는 없다 |
| `FunctionComponent` | `hooks` 배열(상태 저장), `mount()`(첫 렌더링), `update()`(재렌더링) |
| `useState` | 값 저장과 변경. 변경되면 자동으로 다시 그린다. 같은 값(`Object.is`)이면 무시 |
| `useEffect` | DOM 반영 **후** 실행. 의존성이 바뀌면 이전 cleanup을 먼저 호출한 뒤 실행 |
| `useMemo` | 계산 결과 캐시. 의존성이 같으면 재사용 |

**함수가 매번 새로 실행되어도 상태가 유지되는 이유**: 상태는 함수 안이 아니라 `FunctionComponent`의 `hooks` 배열에 있고, Hook은 호출 순서(인덱스)로 자기 칸을 찾는다.

**의존성 규칙** (`useEffect`·`useMemo` 공통): 각 항목을 `Object.is`로 비교한다. 생략 = 매 렌더, `[]` = 최초 한 번, `[a, b]` = 값이 바뀔 때.

### 제약 (정의서 준수)
- Hook과 상태는 **루트 컴포넌트에서만** 쓴다. 자식 컴포넌트에서 Hook을 호출하면 에러.
- 자식 컴포넌트는 props만 받는 순수 함수다 (Lifting State Up).
- Hook은 조건문·반복문 안에서 호출하지 않는다. 렌더링마다 호출 개수가 달라지면 에러.

## 추가로 검증한 부분 (견고성)

정의서 요구 외에, 구현하며 확인하고 보강한 부분이다. 각 항목은 단위 테스트로 검증한다.

| 영역 | 검증·보강 내용 |
| --- | --- |
| **DOM 인덱스 일치** | 주석·`<script>`를 Virtual DOM에서 빼는 만큼 실제 DOM에서도 정리(`cleanContainer`)해, Virtual DOM 인덱스와 실제 DOM 인덱스가 어긋나 엉뚱한 노드를 패치하는 문제를 막는다. `<template>` 내부도 포함 |
| **이벤트 핸들러** | 교체 시 이전 리스너 제거·중복 실행 방지, 속성 제거·함수 → 문자열 변경 시 리스너 제거 |
| **실행 경로 차단** | `<script>` 렌더링 제외, 문자열 `on*` 속성 무시, `srcdoc`, URL 속성(`href` `src` `action` `formaction` `data` `poster` `background` `cite` `longdesc` `xlink:href`)의 `javascript:` `vbscript:` `data:text/html` 값 차단. 공백·제어문자 우회도 처리 |
| **불변 스냅샷** | 히스토리·직전 렌더 결과를 깊게 얼려, 이후 코드가 몰래 바꿔 기록이 오염되는 일을 막는다 |
| **Hook 일관성** | 호출 개수·종류가 달라지면 에러. 에러가 나도 Hook 저장소에 슬롯이 늘지 않음 |
| **렌더 실패 복구** | 렌더링 중 에러가 나면 effect·memo 기록을 마지막 정상 렌더 기준으로 유지(성공한 렌더에서만 확정). 같은 새 의존성으로 복구하면 effect가 정상 실행됨 |
| **SVG** | SVG 네임스페이스로 요소 생성, `xlink:href`는 네임스페이스와 함께 반영 |
| **입력값** | `value`·`checked`는 속성과 프로퍼티를 함께 맞춰, 입력창이 다시 그려져도 포커스·값 유지 |
| **`h()` 입력 검사** | DOM 노드, 호출하지 않은 컴포넌트 등 Virtual DOM이 아닌 값을 자식으로 넣으면 에러 |

## 단위 테스트

브라우저에서 `test.html`을 열면 121개가 실행된다. 외부 도구 없이 직접 만든 러너(`tests/runner.js`)를 쓴다.

| 파일 | 검증 대상 | 테스트 수 |
| --- | --- | --- |
| `tests/vdom.test.js` | DOM → Virtual DOM, `cleanContainer`, `<template>`, `deepFreeze` | 23 |
| `tests/diff-patch.test.js` | Diff, Patch(`<template>` 내부 포함), 핸들러·차단 속성 | 37 |
| `tests/history.test.js` | `StateHistory`, `index.html` 페이지 동작(iframe으로 실제 클릭·입력) | 13 |
| `tests/hooks.test.js` | `useState` `useEffect` `useMemo`, Hook 규칙, 렌더 실패 복구, `h()` | 48 |

테스트가 실제 결함을 잡는지 확인하기 위해, 코드를 일부러 망가뜨려 테스트가 실패하는지도 확인했다 (예: 이전 방식으로 되돌리면 의도한 테스트가 실패).

## 설계 결정

정의서가 정하지 않은 부분은 아래와 같이 정했다.

| 항목 | 결정 |
| --- | --- |
| Virtual DOM 구조 | `{type, tag, props, children}` / `{type:"text", value}`, key 없음 |
| 5가지 핵심 케이스 | `CREATE` `REMOVE` `REPLACE` `UPDATE_PROPS` `UPDATE_TEXT` |
| 테스트 영역 편집 방식 | 코드 입력 칸(textarea) + 미리보기 |
| 히스토리 경계 | 경계에서는 이동하지 않음, 과거에서 Patch 시 미래 기록 삭제, 변경 없는 Patch는 기록 안 함 |
| 공백·주석 | 공백 텍스트는 보존, 주석은 제외 |
| `<script>` | 렌더링하지 않아 실행하지 않음 |
| 자식 컴포넌트·Hook 제한 | 자식은 `(props) => VNode` 순수 함수, 루트 렌더링 중에만 Hook 허용 |
| `useEffect` | Patch 후 실행, deps 비교, 재실행 전 cleanup 지원 |

## 실제 React와의 차이 · 알려진 한계

| | Mini React | 실제 React |
| --- | --- | --- |
| 재렌더링 | 동기, 재귀 비교 (**Fiber 없음**) | Fiber 트리, 중단·재개 가능 |
| 상태 변경 처리 | 호출마다 즉시 렌더 (**Batching 없음**) | 묶어서 처리 |
| 자식 비교 | 인덱스 (**key 없음**) | key 기반 이동 |
| 상태 위치 | 루트 컴포넌트만 | 모든 컴포넌트 |

- 순서가 바뀐 목록은 노드를 이동하지 않고 위치별로 내용을 수정한다. 노드 동일성·포커스 보존을 기대하면 안 된다.
- 함수 prop은 `!==`로 비교하므로, 렌더링마다 새로 만드는 핸들러는 매번 `UPDATE_PROPS`로 나온다. DOM 노드는 재생성되지 않고 이전 리스너가 교체되므로 중복 실행되지는 않는다.
- **차단 범위는 "정한 속성·값만"이다.** 모든 위험한 입력을 막는 것이 아니다. 막지 않는 예: SVG `<animate values="javascript:...">`, `style` 속성, `<meta http-equiv="refresh">`.
- `setState`로 바꾼 값은 이후 렌더가 실패해도 롤백하지 않는다.
- 컴포넌트 제거(unmount) 시 cleanup은 구현하지 않았다.
- 정적 샘플 HTML(실제 영역)의 주석·`<script>`는 로드 시 한 번 정리한다. 그 이후의 DOM은 Virtual DOM에서 만들어지므로 같은 문제가 생기지 않는다.

## 진행 상황

| 제출물 | 상태 |
| --- | --- |
| ① Phase 1 검증 웹 페이지 | 완료 (`index.html`) |
| ② Phase 1·2를 활용한 테스트 페이지 (주제 자유) | **미완성**: 주제 미정. 확정되면 작성 예정 |
| ③ 단위 테스트 | 완료 (121개) |
| ④ 기능 테스트 | **미완성**: ②의 주제가 정해진 뒤 입력·클릭부터 부분 갱신까지 덧붙일 예정. Phase 1 페이지 동작 테스트는 `history.test.js`에 일부 포함 |
| 선택 과제: Batching | 미구현 |

## 프로젝트 구조

```
.
├── index.html              Phase 1 검증 페이지
├── test.html               단위 테스트 실행 페이지
├── css/style.css
├── src/
│   ├── vdom.js             DOM → Virtual DOM 변환, cleanContainer, deepFreeze
│   ├── diff.js             Diff: 변경 목록 생성
│   ├── patch.js            Patch: 변경 목록 → 실제 DOM
│   ├── dom.js              Virtual DOM → 실제 DOM(render), 속성·이벤트 적용, 차단 속성
│   ├── history.js          State History
│   ├── mini-react.js       h, FunctionComponent, useState/useEffect/useMemo
│   └── main.js             Phase 1 검증 페이지 연결
├── tests/                  runner.js + 단위 테스트
└── docs/                   아키텍처·치트시트·워크스루·발표 대본
```

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 전체 데이터 흐름 다이어그램 (Mermaid) |
| [docs/cheatsheet.md](docs/cheatsheet.md) | 3분 요약: 모듈 역할, 핵심 함수, 규칙 |
| [docs/walkthrough.md](docs/walkthrough.md) | 샘플 HTML이 Patch되기까지 단계별 before/after (실제 실행값) |
| [docs/presentation-script.md](docs/presentation-script.md) | 발표 대본 |

## 의존 관계

```
index.html → main.js ─┬→ vdom.js
                      ├→ diff.js
                      ├→ patch.js ──→ dom.js
                      └→ history.js

mini-react.js ─→ vdom.js, dom.js, diff.js, patch.js   (Phase 2가 Phase 1을 재사용)
```
