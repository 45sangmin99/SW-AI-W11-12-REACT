# Mini React 아키텍처: 데이터 흐름

> 이 구현에는 JSX 변환기가 없다. JSX 자리에는 `h(tag, props, ...children)` 호출을 직접 쓴다.
> `h()`가 React의 `createElement`에 해당한다.

## 1. 전체 흐름 (Phase 2: 컴포넌트가 화면을 갱신하기까지)

```mermaid
flowchart TD
    subgraph W["① 선언 (사용자 코드)"]
        A["컴포넌트 함수<br/>function App() { ... }<br/>return h('div', null, ...)"]
        A2["자식 컴포넌트<br/>(props) => h(...)<br/>순수 함수, Hook 금지"]
    end

    subgraph H["② h() = createElement (src/mini-react.js)"]
        B["h(tag, props, ...children)<br/>props 정규화 · 자식 평탄화<br/>문자열/숫자 → 텍스트 노드<br/>script → null 제외"]
    end

    V[("Virtual DOM 트리<br/>{type:'element', tag, props, children}<br/>{type:'text', value}<br/>deepFreeze로 불변")]

    subgraph FC["③ FunctionComponent (src/mini-react.js)"]
        direction TB
        R["#renderVdom()<br/>Hook 문맥 설정 → 함수 실행<br/>검증 후 Hook 기록 확정(staged)"]
        HK[("hooks 배열<br/>useState 값 · useMemo 캐시<br/>useEffect deps / cleanup")]
        M["mount(container)<br/>첫 렌더링"]
        U["update()<br/>상태 변경 후 재렌더링"]
        E["#runEffects()<br/>cleanup → effect 순서로 실행"]
    end

    subgraph P1["④ Phase 1 코어 (재사용)"]
        D["diff(oldVdom, newVdom)<br/>src/diff.js"]
        CH[/"변경 목록 (path 기반)<br/>CREATE · REMOVE · REPLACE<br/>UPDATE_PROPS · UPDATE_TEXT"/]
        PT["patch(rootEl, changes)<br/>src/patch.js"]
        RD["render(vnode)<br/>setProp / removeProp<br/>src/dom.js"]
    end

    DOM[("⑤ 실제 DOM<br/>바뀐 노드만 갱신")]

    EV(["사용자 입력 / 클릭<br/>onClick · onInput"])

    A --> B
    A2 --> B
    B --> V
    V --> R
    HK <--> R
    R --> M
    R --> U

    M -->|"첫 렌더링: 전체 생성"| RD
    RD --> DOM
    U -->|"이전 vdom vs 새 vdom"| D
    D --> CH --> PT
    PT -->|"새 노드가 필요할 때"| RD
    PT --> DOM

    DOM -->|"Patch 완료 후"| E
    E -.->|"effect 안의 setState"| U
    DOM --> EV
    EV -->|"setState(value)<br/>Object.is로 같은 값이면 무시"| HK
    HK -->|"값이 바뀌면 자동 호출"| U
```

### 읽는 법
1. **선언 → ②**: 컴포넌트가 `h()`를 호출해 Virtual DOM 트리를 만든다. 자식 컴포넌트는 `h()` 안에서 즉시 호출된다.
2. **③ 렌더링**: 루트 `FunctionComponent`만 Hook과 상태(`hooks` 배열)를 가진다. 렌더링 중 변경은 임시 기록으로 모아 두었다가 성공한 뒤에만 확정한다.
3. **④ Diff → Patch**: 이전 Virtual DOM과 새 Virtual DOM을 비교해 변경 목록을 만들고, 목록의 노드만 실제 DOM에 반영한다.
4. **⑤ 실제 DOM**: 변경 없는 노드는 그대로 유지된다(포커스, 입력 중인 값 보존).
5. **되돌아오는 루프**: 사용자 이벤트 → `setState` → `update()` → 다시 ③.

## 2. Phase 1 검증 페이지의 흐름 (index.html)

같은 Diff·Patch·render 모듈을 쓰되, 입력은 `h()`가 아니라 **HTML**이다.

```mermaid
flowchart LR
    S["실제 영역의 샘플 HTML<br/>(#real-root)"] -->|"cleanContainer<br/>주석·script 제거"| C1["containerToVdom()"]
    C1 --> V0[("현재 Virtual DOM")]
    V0 -->|"로드 시 render"| T["테스트 영역<br/>(#test-root 미리보기)"]

    ED["코드 편집 칸 textarea"] -->|"입력할 때마다<br/>htmlToVdom → render"| T

    T -->|"Patch 버튼<br/>containerToVdom()"| V1[("새 Virtual DOM")]
    V0 --> DF["diff(현재, 새)"]
    V1 --> DF
    DF -->|"변경 없음"| NO["아무 일도 하지 않음<br/>(기록 추가 안 함)"]
    DF -->|"변경 목록"| PA["patch(real-root)"]
    PA --> S
    V1 --> HS[("StateHistory<br/>push 시 deepFreeze<br/>과거에서 push하면 미래 기록 삭제")]

    HS -->|"뒤로가기 / 앞으로가기<br/>경계에서는 이동 안 함"| MV["diff(현재, 이동할 상태)<br/>→ patch(real-root)"]
    MV --> S
    HS -->|"테스트 영역도 함께 렌더링<br/>코드 칸도 갱신"| T
```

## 3. 모듈 의존 관계

| 모듈 | 역할 | 의존 |
| --- | --- | --- |
| `src/vdom.js` | DOM → Virtual DOM, `cleanContainer`, `deepFreeze`, `childContainer` | 없음 |
| `src/dom.js` | Virtual DOM → 실제 DOM(`render`), `setProp`/`removeProp`, 차단 속성 | `vdom.js` |
| `src/diff.js` | 두 Virtual DOM 비교 → 변경 목록 | `vdom.js` |
| `src/patch.js` | 변경 목록 → 실제 DOM 반영 | `dom.js`, `diff.js`, `vdom.js` |
| `src/history.js` | State History | `vdom.js` |
| `src/mini-react.js` | `h()`, `FunctionComponent`, Hooks | `vdom.js`, `dom.js`, `diff.js`, `patch.js` |
| `src/main.js` | Phase 1 검증 페이지 연결 | 위 모듈 전부(`mini-react.js` 제외) |
