# 코드 워크스루: 샘플 HTML이 Patch되기까지

> 이 문서의 모든 객체는 **실제 코드를 실행해서 나온 값**이다 (손으로 쓴 예상값이 아니다).
> 함수 위치는 줄 번호가 아니라 함수명으로 적는다. 코드가 바뀌면 줄 번호는 어긋난다.
> 전체 구조는 [architecture.md](architecture.md), 요약은 [cheatsheet.md](cheatsheet.md).

## 0. 시나리오

실제 영역에 이 HTML이 있고, 테스트 영역에서 아래처럼 고친 뒤 **Patch** 버튼을 누른다.

```html
<!-- before (실제 영역) -->
<h1 class="title">Hello</h1><ul><li>A</li><li>B</li></ul><p>old</p><i>x</i>

<!-- after (테스트 영역에서 수정) -->
<h1 class="title big">Hi</h1><ul><li>A</li><li>B</li><li>C</li></ul><b>old</b>
```

바뀐 것은 5가지다: **속성**(h1 class), **텍스트**(Hello→Hi), **추가**(li C), **타입 교체**(p→b), **삭제**(i).
목표는 `h1`, `ul`, 첫 번째 `li` 같은 **바뀌지 않은 DOM 노드를 건드리지 않고** 결과를 만드는 것이다.

```
before HTML ──①변환──▶ oldVdom ─┐
                                ├─②diff──▶ changes ──③patch──▶ 실제 DOM
after  HTML ──①변환──▶ newVdom ─┘
```

---

## 1단계. DOM → Virtual DOM (`src/vdom.js`)

### 왜 변환하나
실제 DOM 노드끼리 직접 비교하면 느리고(속성·레이아웃 접근 비용), 비교 결과를 "데이터"로 남길 수도 없다.
일반 객체로 바꿔 두면 **빠르게 비교할 수 있고, 변경 목록을 값으로 저장·전달할 수 있다.**

### 호출
```js
cleanContainer(realRoot);               // (로드 시 1회) 주석·<script> 제거
const oldVdom = containerToVdom(realRoot);
```

### 라인별 인과관계
| 코드(함수) | 하는 일 | 왜 필요한가 |
| --- | --- | --- |
| `cleanContainer` | 실제 DOM에서 주석·`<script>`를 지우고 `normalize()` | Virtual DOM은 이 둘을 **제외**한다. 실제 DOM에 남겨 두면 `childNodes[1]`이 가리키는 노드가 서로 달라져 **엉뚱한 노드를 패치**한다. 인덱스를 1:1로 맞추기 위한 선행 작업이다 |
| `containerToVdom` | 컨테이너의 *내용물*을 `tag:"div", props:{}` 루트 아래에 넣는다 | 컨테이너 자체의 `id="real-root"`와 테스트 영역의 `id="test-root"`가 달라서, 컨테이너를 그대로 비교하면 매번 "id가 바뀌었다"로 잡힌다. 루트를 중립(빈 div)으로 고정해 이를 막는다 |
| `domToVdom` (텍스트) | `{type:"text", value}` | 공백만 있는 텍스트도 보존한다. 지우면 실제 DOM의 자식 수와 어긋난다 |
| `domToVdom` (요소) | `attributes`를 `props`로, `childNodes`를 재귀 변환 | 속성은 문자열 맵, 자식은 배열이면 비교가 단순해진다 |
| `domToVdom` (주석/script) | `null` 반환 | 화면과 무관하거나 실행 위험이 있는 노드를 Virtual DOM 단계에서 차단한다 |

### 결과: `oldVdom`
```js
{ type: "element", tag: "div", props: {}, children: [
  { type: "element", tag: "h1", props: { class: "title" },
    children: [ { type: "text", value: "Hello" } ] },                      // [0]
  { type: "element", tag: "ul", props: {}, children: [
    { type: "element", tag: "li", props: {}, children: [ { type: "text", value: "A" } ] },   // [1,0]
    { type: "element", tag: "li", props: {}, children: [ { type: "text", value: "B" } ] } ] },// [1,1]
  { type: "element", tag: "p", props: {}, children: [ { type: "text", value: "old" } ] },    // [2]
  { type: "element", tag: "i", props: {}, children: [ { type: "text", value: "x" } ] }       // [3]
] }
```
각 노드 옆의 `[...]`가 **path**다. 이후 모든 단계에서 "어느 노드인가"를 이 인덱스 배열로 가리킨다.

---

## 2단계. 새 Virtual DOM 만들기 (`htmlToVdom`)

```js
const newVdom = containerToVdom(testRoot);   // Patch 버튼을 누를 때
```
실제 앱에서 새 트리는 테스트 영역 DOM에서 만든다. 같은 함수라서 **양쪽이 같은 규칙으로 변환된다는 보장**이 있다.
(편집 칸에서 입력할 때 미리보기용으로 쓰는 `htmlToVdom`은 `<template>` 안에서 파싱한다. 거기서는 `<img onerror>`·스크립트가 실행되지 않는다.)

### 결과: `newVdom` (바뀐 부분만 표시)
```js
{ type: "element", tag: "div", props: {}, children: [
  { type: "element", tag: "h1", props: { class: "title big" },              // ← 속성 변경
    children: [ { type: "text", value: "Hi" } ] },                          // ← 텍스트 변경
  { type: "element", tag: "ul", props: {}, children: [
    /* li A, li B 는 동일 */
    { type: "element", tag: "li", props: {}, children: [ { type: "text", value: "C" } ] } ] }, // ← 추가
  { type: "element", tag: "b", props: {}, children: [ { type: "text", value: "old" } ] }       // ← p가 b로
  // i 는 없다                                                               // ← 삭제
] }
```

---

## 3단계. Diff (`src/diff.js`)

### 왜 이런 모양의 결과를 만드나
Diff는 DOM을 직접 고치지 않고 **"무엇을 어디서 어떻게 바꿀지" 목록**만 만든다.
역할을 나눠 두면 Diff를 DOM 없이 테스트할 수 있고, 같은 목록을 Phase 1(HTML)과 Phase 2(컴포넌트)가 똑같이 쓴다.

### 비교 과정 추적 (`walk`가 위에서 아래로 재귀)
| # | 비교 대상 (path) | 판단 | 만드는 변경 | 왜 이 판단인가 |
| --- | --- | --- | --- | --- |
| 1 | 루트 div `[]` | 태그·props 같음 | 없음 | 루트는 항상 빈 div이므로 여기서 변경이 생기지 않는다 |
| 2 | 루트의 자식 수 | 이전 4개, 새 3개 → `common = min(4,3) = 3` | — | 앞 3개는 짝지어 비교하고, 남는 쪽은 추가/삭제로 처리한다 |
| 3 | `h1` `[0]` | 태그 같음, `class` 값 다름 | **UPDATE_PROPS** `{set:{class:"title big"}, remove:[]}` | 태그가 같으면 노드를 재사용하고 속성만 고친다 |
| 4 | h1의 텍스트 `[0,0]` | 타입 같음(text), 값 다름 | **UPDATE_TEXT** `"Hi"` | 텍스트는 `nodeValue`만 바꾸면 된다 |
| 5 | `ul` `[1]` | 태그·props 같음 | 없음 | 하지만 자식은 계속 내려가 본다 |
| 6 | ul의 `li A`, `li B` | 완전히 같음 | 없음 | 변경 없음 → 이 노드들은 **DOM에서 손대지 않는다** |
| 7 | ul의 자식 수 | 2개 → 3개, 남은 새 노드 1개 | **CREATE** `path:[1]` (= 부모 ul) | 추가는 "어느 부모의 끝에 붙일지"가 필요해서 path가 **부모**를 가리킨다 |
| 8 | `p` vs `b` `[2]` | **태그가 다름** | **REPLACE** `path:[2]`, `node:<b>` | 태그가 다르면 속성·자식을 맞추는 것보다 통째로 교체하는 것이 단순하고 정확하다. 그래서 `<b>` 안의 텍스트는 따로 비교하지 않는다 |
| 9 | 루트의 남는 이전 노드 `i` | 이전 4개 > common 3 | **REMOVE** `path:[3]` | 새 트리에 짝이 없는 이전 노드는 삭제한다 |

> 삭제는 `for (let i = oldKids.length - 1; i >= common; i--)` 처럼 **뒤에서부터** 만든다.
> 앞에서부터 지우면 뒤 노드의 인덱스가 밀려서, 다음 변경의 path가 틀어진다.

### 결과: `changes` (실제 출력)
```js
[
  { type: "UPDATE_PROPS", path: [0],    set: { class: "title big" }, remove: [] },
  { type: "UPDATE_TEXT",  path: [0, 0], value: "Hi" },
  { type: "CREATE",       path: [1],    node: { type: "element", tag: "li", props: {},
                                                children: [ { type: "text", value: "C" } ] } },
  { type: "REPLACE",      path: [2],    node: { type: "element", tag: "b", props: {},
                                                children: [ { type: "text", value: "old" } ] } },
  { type: "REMOVE",       path: [3] }
]
```
5가지 변경 종류가 한 번에 모두 나온다. 변경 없는 `li A`, `li B`, `ul`은 목록에 **등장하지 않는다.**

---

## 4단계. Patch (`src/patch.js`)

### 왜 목록을 순서대로 적용하나
각 변경은 "path로 노드를 찾아서(`resolve`) → 종류별로 처리"하는 독립 작업이다.
Diff가 인덱스가 밀리지 않도록 순서를 이미 정해 두었으므로(삭제는 뒤에서부터, 교체는 위치 유지), 그냥 앞에서부터 적용하면 된다.

### 적용 과정 (`patch(realRoot, changes)`)
| # | 변경 | `resolve`가 찾는 노드 | DOM에 일어나는 일 | 왜 이 방법인가 |
| --- | --- | --- | --- | --- |
| 1 | UPDATE_PROPS `[0]` | `realRoot.childNodes[0]` = `<h1>` | `setProp(h1, "class", "title big")` | 기존 `h1`을 그대로 두고 속성만 바꾼다 |
| 2 | UPDATE_TEXT `[0,0]` | `h1.childNodes[0]` = 텍스트 노드 | `nodeValue = "Hi"` | 텍스트 노드 값만 교체. 요소를 다시 만들지 않는다 |
| 3 | CREATE `[1]` | `realRoot.childNodes[1]` = `<ul>` | `ul.appendChild(render(<li>C</li>))` | `render`가 Virtual DOM 노드로부터 새 DOM 노드를 **그때 한 번만** 만든다 |
| 4 | REPLACE `[2]` | `childNodes[2]` = `<p>` | `p.replaceWith(render(<b>))` | 같은 자리(인덱스 2)에 교체해서 뒤 노드들의 인덱스를 유지한다 |
| 5 | REMOVE `[3]` | `childNodes[3]` = `<i>` | `i.remove()` | 마지막 변경이라 앞선 인덱스에 영향이 없다 |

### 결과 (실제 출력)
```html
<h1 class="title big">Hi</h1><ul><li>A</li><li>B</li><li>C</li></ul><b>old</b>
```
```js
// 변경 전에 잡아 둔 노드 참조와 비교한 결과
같은 DOM 노드인가?  h1: true   ul: true   첫 li: true      // ← 유지됨 (재생성되지 않음)
사라졌는가?        p: true    i: true                      // ← REPLACE·REMOVE 대상
```
바뀐 곳만 갱신되었다는 것이 **노드 동일성**으로 증명된다. 이것이 Virtual DOM + Diff의 존재 이유다.

### `render`와 `setProp`이 속성을 다루는 규칙 (`src/dom.js`)
| 상황 | 동작 | 왜 |
| --- | --- | --- |
| `onClick` 같은 **함수** | 이전 리스너를 지우고 새 리스너 등록 | 안 지우면 클릭 한 번에 핸들러가 여러 번 실행된다 |
| 문자열 `onclick="..."` | 반영하지 않음 | 문자열 이벤트는 코드 실행 경로다 |
| `href="javascript:..."`, `srcdoc` 등 | 속성 자체를 제거 | 차단 대상. 이전 값이 남지 않도록 제거한다 |
| `value`·`checked` | **속성과 프로퍼티 모두** 설정 | 프로퍼티만 바꾸면 이후 Virtual DOM 변환이 속성값을 읽어 어긋난다 |

---

## 5단계. 같은 파이프라인을 Phase 2가 쓰는 방식 (`setState`)

```js
function App() {
  const [n, setN] = useState(0);
  return h("button", { onClick: () => setN(n + 1) }, "클릭 ", n);
}
new FunctionComponent(App).mount(box);   // → <button>클릭 0</button>
// 버튼 클릭 → setN(1)
```

### 인과관계 사슬
```
setN(1)
 → Object.is(1, 0)? 다름 → hook.value = 1            (같은 값이면 여기서 끝: 불필요한 렌더 방지)
 → component.update()                                 (상태가 바뀌었으니 화면을 다시 계산해야 한다)
 → #renderVdom(): App()을 다시 실행 → 새 Virtual DOM   (함수를 다시 실행해도 n은 hooks 배열에서 가져와 유지된다)
 → diff(이전 vdom, 새 vdom)                           (이전 vdom은 this.vdom에 저장돼 있다)
 → patch(rootEl, changes)                             (바뀐 노드만 반영)
 → this.vdom = 새 vdom                                (다음 렌더의 "이전"이 된다)
 → #runEffects()                                      (effect는 DOM 반영 이후에 실행한다)
```

### Before / After (실제 출력)
```js
// 이전 vdom                                            // 새 vdom
{ type:"element", tag:"button",                         { type:"element", tag:"button",
  props:{ onClick: [Function] },                          props:{ onClick: [Function] },   // 새 클로저
  children:[ {type:"text", value:"클릭 "},                children:[ {type:"text", value:"클릭 "},
             {type:"text", value:"0"} ] }                            {type:"text", value:"1"} ] }
```
```js
// diff 결과 (실제 출력)
[ { type: "UPDATE_PROPS", path: [],  set: { onClick: [Function] }, remove: [] },
  { type: "UPDATE_TEXT",  path: [1], value: "1" } ]
```
`<button>` DOM 노드는 클릭 전후로 **같은 노드**다 (`true`로 확인). 입력창이었다면 포커스와 입력 중인 값이 유지된다.

### 이 출력에서 알아 둘 점 (실제 동작이다)
1. **`UPDATE_PROPS onClick`이 매번 나온다.** 렌더링마다 `() => setN(n + 1)`이 새 함수로 만들어지고, Diff는 함수를 `!==`로 비교하기 때문이다. DOM 노드는 재생성되지 않고, `setProp`이 이전 리스너를 지운 뒤 새 리스너를 붙이므로 **핸들러가 중복 실행되지는 않는다.** 대신 항상 최신 `n`을 캡처한 핸들러가 붙는다는 이점이 있다.
2. **텍스트가 두 노드로 나뉜다** (`"클릭 "`, `"0"`). `h()`는 인접한 텍스트를 합치지 않는다. 그래야 Virtual DOM 자식과 실제 DOM 자식이 1:1로 대응한다 (`path:[1]`이 정확히 숫자 노드를 가리킨다).

---

## 6. 한눈에 보는 인과관계 요약

| 설계 결정 | 이유 | 이 결정이 막는 문제 |
| --- | --- | --- |
| DOM을 일반 객체로 변환 | 빠른 비교, 변경 목록을 값으로 다룸 | 느린 DOM 직접 비교 |
| 주석·script를 양쪽에서 제거 | Virtual DOM 인덱스 == DOM 인덱스 | 엉뚱한 노드 패치 |
| Diff는 목록만, Patch가 적용 | 역할 분리 (테스트·재사용) | Phase 1/2 코드 중복 |
| CREATE는 부모 path, REMOVE는 뒤에서부터 | 인덱스 밀림 방지 | 잘못된 위치 패치 |
| 태그가 다르면 REPLACE | 속성·자식 맞추기보다 단순·정확 | 복잡한 부분 수정 |
| 함수 prop은 리스너 교체 | 최신 클로저 유지 | 중복·낡은 핸들러 |
| 저장된 vdom은 `deepFreeze` | 이전 vdom이 몰래 바뀌면 diff가 틀림 | 히스토리·diff 오염 |

## 7. 직접 확인하는 법
1. `index.html`을 열고(로컬 서버 필요) 테스트 영역 코드 칸에서 위 after HTML로 고친 뒤 **Patch**.
2. 개발자 도구 Elements에서 `h1`, `ul`을 선택해 둔 채 Patch하면, 선택이 유지되고 깜빡임 없이 바뀐 줄만 갱신되는 것을 볼 수 있다 (노드가 교체되지 않기 때문이다).
3. `test.html`의 "Patch: 변경 없는 노드는 같은 DOM 노드로 유지된다" 테스트가 같은 사실을 자동으로 검증한다.
