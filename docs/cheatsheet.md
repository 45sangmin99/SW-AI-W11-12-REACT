# Mini React Technical Cheat Sheet (3분 요약)

> 바닐라 JS(ES Modules)로 만든 미니 리액트. 외부 라이브러리 없음. 전체 흐름 그림은 [architecture.md](architecture.md).

## 한 줄 요약
**`h()`로 Virtual DOM을 만들고 → 이전 것과 `diff` → 바뀐 노드만 `patch`.**
상태(`useState`)가 바뀌면 이 과정이 자동으로 다시 돈다.

## 1. 데이터 모양 (이것만 알면 나머지는 읽힌다)
```js
{ type: "element", tag: "div", props: { class: "a" }, children: [ ...노드 ] }
{ type: "text", value: "안녕" }
```
- `key` 없음. 자식은 **인덱스 순서로** 비교한다.
- 한 번 저장된 Virtual DOM은 `deepFreeze`로 **불변**이다. 직접 수정하면 에러가 난다.

## 2. 모듈별 역할과 핵심 함수
| 모듈 | 역할 | 핵심 함수 |
| --- | --- | --- |
| `src/vdom.js` | DOM → Virtual DOM 변환 | `domToVdom`, `containerToVdom`, `htmlToVdom`, `cleanContainer`, `deepFreeze`, `childContainer` |
| `src/diff.js` | 두 Virtual DOM 비교 → **변경 목록** | `diff(old, new)` |
| `src/patch.js` | 변경 목록 → 실제 DOM 반영 | `patch(rootEl, changes)` |
| `src/dom.js` | Virtual DOM → 실제 DOM 생성, 속성·이벤트 적용 | `render`, `setProp`, `removeProp`, `isUnsafeAttr` |
| `src/history.js` | Phase 1의 뒤로/앞으로가기 기록 | `StateHistory` (`push`, `back`, `forward`) |
| `src/mini-react.js` | 컴포넌트, 상태, Hooks | `h`, `FunctionComponent` (`mount`, `update`), `useState`, `useEffect`, `useMemo` |
| `src/main.js` | Phase 1 검증 페이지 연결 | — |

### Diff가 만드는 5가지 변경
`CREATE` 추가 · `REMOVE` 삭제 · `REPLACE` 타입 교체 · `UPDATE_PROPS` 속성 변경 · `UPDATE_TEXT` 텍스트 변경
각 변경은 `path`(루트부터의 자식 인덱스 배열)를 가진다. 예: `[0, 2]` = 루트의 0번째 자식의 2번째 자식.

### 렌더링 흐름
```
setState → update() → #renderVdom()(새 vdom) → diff(이전, 새) → patch() → useEffect 실행
```
첫 렌더링은 `mount()`가 `render()`로 전체를 만든다.

## 3. Fiber는? — 없다
| | Mini React | 실제 React |
| --- | --- | --- |
| 재렌더링 | **동기**, 재귀 비교 | Fiber 트리, 중단·재개 가능한 스케줄링 |
| 비교 단위 | 전체 vdom 트리 | Fiber 노드 |
| 상태 변경 처리 | 호출마다 즉시 렌더 (**Batching 없음**) | 묶어서 처리 |
| 자식 비교 | 인덱스 (key 없음) | key 기반 이동 |
| 상태 위치 | **루트 컴포넌트만** | 모든 컴포넌트 |

## 4. 이 아키텍처의 가장 큰 특징
1. **Phase 1 코어를 Phase 2가 그대로 재사용**: 검증 페이지와 컴포넌트가 같은 `diff`/`patch`를 쓴다.
2. **상태는 루트에만 (Lifting State Up)**: 자식은 props만 받는 순수 함수. 자식에서 Hook을 쓰면 에러.
3. **Hook은 "성공한 렌더"에서만 확정**: 렌더 중 에러가 나면 effect·memo 기록이 마지막 정상 상태로 유지된다 (`staged` 임시 기록).
4. **"Virtual DOM 인덱스 == 실제 DOM 인덱스" 불변식**: 주석·`<script>`는 Virtual DOM에서 제외하고, 정적 HTML은 `cleanContainer`로 같이 정리한다. 이게 깨지면 엉뚱한 노드를 패치한다.
5. **불변 스냅샷**: 히스토리와 직전 렌더 결과는 얼려져 있어 이후 변경에 오염되지 않는다.

## 5. 반드시 지킬 규칙
- Hook은 **루트 컴포넌트 렌더링 중에만**, **조건문·반복문 밖에서**, **매 렌더 같은 개수·순서로** 호출한다.
- 루트 컴포넌트는 **요소 하나**를 반환한다. 자식 컴포넌트는 `h(Child, props)`로 호출한다 (직접 호출하지 않는다).
- `useEffect`/`useMemo` deps는 `Object.is`로 비교한다. 생략 = 매번, `[]` = 한 번, `[a, b]` = 바뀔 때. **렌더마다 새로 만드는 객체·배열을 deps에 넣으면 매번 다시 실행된다.**
- 순서가 바뀐 목록은 노드를 **이동하지 않고 위치별로 수정한다.** 노드 동일성·포커스 보존을 기대하지 말 것.

## 6. 보안: 막는 것과 막지 않는 것
- **막는 것**: `<script>`(렌더링 제외), 문자열 `on*` 속성, `srcdoc`, URL 속성(`href`, `src`, `action`, `formaction`, `data`, `poster`, `background`, `cite`, `longdesc`, `xlink:href`)의 `javascript:`·`vbscript:`·`data:text/html`.
- **막지 않는 것**: SVG `<animate values="javascript:...">`, `style`, `<meta refresh>` 등 위 목록 밖의 경로. "모든 위험한 입력을 막는다"가 아니다.

## 7. 알려진 한계
- Batching, key 기반 이동, unmount cleanup, Fiber 스케줄링 없음.
- `setState`로 바꾼 값은 이후 렌더가 실패해도 롤백하지 않는다.
- 테스트 페이지(②)와 기능 테스트(④)는 주제 확정 후 작성 예정.

## 8. 바로 써보기
| 하고 싶은 것 | 방법 |
| --- | --- |
| Phase 1 검증 페이지 | `index.html` 열기 (로컬 서버 필요) |
| 단위 테스트 (121개) | `test.html` 열기 |
| 서버 실행 | `python3 -m http.server` 후 `localhost:8000` |

```js
import { h, FunctionComponent, useState } from "./src/mini-react.js";

function App() {
  const [n, setN] = useState(0);
  return h("button", { onClick: () => setN(n + 1) }, `클릭 ${n}`);
}
new FunctionComponent(App).mount(document.getElementById("app"));
```
