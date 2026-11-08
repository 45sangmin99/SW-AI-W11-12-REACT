# Mini React

React 없이 브라우저 DOM을 Virtual DOM으로 바꾸고, 두 트리의 차이만 실제 DOM에 반영하는 학습 프로젝트입니다. 함수형 Component와 `useState`, `useEffect`, `useMemo`도 Vanilla JavaScript로 구현했습니다.

검증 페이지는 두 실습으로 나뉩니다.

- **실습 1 — Virtual DOM:** 사용자가 편집한 트리를 Diff하고 Patch와 History를 확인합니다.
- **실습 2 — State와 Hooks:** 할 일 앱을 조작하며 State 변경이 Component 재실행과 DOM Patch로 이어지는 과정을 확인합니다.

## 실행

Node.js가 필요합니다. 프로젝트 폴더에서 다음 명령을 실행합니다.

```powershell
node --run dev
```

브라우저에서 <http://127.0.0.1:3000>을 엽니다. 서버를 종료할 때는 터미널에서 `Ctrl+C`를 누릅니다.

전체 테스트:

```powershell
node --run test
```

## 실습 1 — Virtual DOM, Diff, Patch

1. 오른쪽 **테스트 영역**의 글이나 HTML 구조를 직접 수정합니다.
2. **Patch 적용**을 누릅니다.
3. 왼쪽 **실제 영역**에 변경된 부분만 반영되는지 확인합니다.
4. **최근 결과**에서 생성·삭제·교체·속성·텍스트 변경 개수를 확인합니다.
5. **이전 상태**와 **다음 상태**로 저장된 Virtual DOM History를 이동합니다.
6. 필요하면 **내부 동작 보기**를 펼쳐 Virtual DOM과 원본 Patch JSON을 확인합니다.

`Patch 적용`은 개발 서버의 새로고침이 아닙니다. 편집 중인 테스트 DOM을 새 Virtual DOM으로 읽고, 이전 Virtual DOM과 비교한 결과를 실제 영역에 적용하는 명시적인 실험 버튼입니다.

### Diff 알고리즘

이 프로젝트의 Diff는 두 트리를 같은 위치부터 재귀 비교하는 자체 구현 알고리즘입니다. 다음 핵심 케이스를 처리합니다.

| 비교 결과 | Patch | 실제 DOM 처리 |
| --- | --- | --- |
| 이전 노드만 존재 | `REMOVE` | 기존 노드 삭제 |
| 새 노드만 존재 | `CREATE` | 새 노드 생성 |
| 노드 타입이 다름 | `REPLACE` | 노드와 하위 트리 교체 |
| 같은 타입, 속성이 다름 | `UPDATE_PROPS` | 기존 노드를 유지하고 속성만 변경 |
| 같은 텍스트 노드, 내용이 다름 | `UPDATE_TEXT` | 텍스트만 변경 |
| 같은 타입의 자식 | 재귀 비교 | 기존 노드를 재사용하며 하위 변경 탐색 |
| `key`가 있는 목록의 순서 변경 | `MOVE` | 같은 항목을 식별해 이동 |

장점은 구현과 Patch 결과를 따라가기 쉽고, 변경되지 않은 DOM 노드를 재사용한다는 점입니다. 반면 실제 React의 Fiber, 우선순위 렌더링, 휴리스틱 최적화까지 구현한 알고리즘은 아닙니다.

## 실습 2 — Component, State, Hooks

1. 입력창에 할 일을 적고 **할 일 추가**를 누릅니다.
2. 항목의 체크박스를 눌러 완료 상태를 변경합니다.
3. **전체 · 진행 중 · 완료** 필터로 표시 목록을 바꿉니다.
4. 개수 요약과 **최근 사용자 행동과 내부 결과**를 확인합니다.
5. 필요하면 **내부 동작 보기**에서 Component Patch JSON을 확인합니다.

각 조작은 다음 흐름으로 이어집니다.

```text
사용자 행동 → 루트 State 변경 → Component 재실행 → Virtual DOM Diff → 실제 DOM Patch
```

### State 소유권과 Hook 역할

- `TodoApp`만 `todos`, `filter`, `draft` State를 소유합니다.
- 입력폼, 필터, 목록, 요약은 State를 만들지 않고 부모가 전달한 props만 사용합니다. 이것이 **Lifting State Up**입니다.
- `useState`는 할 일·필터·입력값을 저장하고 setter 호출 직후 다시 렌더링합니다.
- `useMemo`는 `todos` 또는 `filter`가 바뀔 때만 표시 목록을 다시 계산합니다.
- `useEffect`는 할 일 개수를 문서 제목에 반영하고 unmount 시 이전 제목을 복구합니다.

## 코드 구조

- `src/vdom.js`: 실제 DOM을 Virtual DOM으로 변환
- `src/render.js`: Virtual DOM을 실제 DOM으로 렌더링
- `src/diff.js`: 이전·다음 Virtual DOM을 비교해 Patch 생성
- `src/patch.js`: Patch를 실제 DOM에 적용
- `src/history.js`: Virtual DOM 스냅샷의 이전·다음 상태 관리
- `src/component.js`: `FunctionComponent`, `useState`, `useEffect`, `useMemo`
- `src/todos.js`: 할 일 필터·완료 전환·문서 제목 동기화 로직
- `src/patch-summary.js`: Patch를 사람이 읽을 수 있는 결과로 변환
- `src/main.js`: 두 실습을 엔진과 연결
- `tests/`: 엔진 단위 테스트와 개발 서버 기능 테스트

## 실제 React와 다른 점

- 하나의 루트 `FunctionComponent`에서만 State와 Hook을 사용합니다.
- State setter는 batching 없이 즉시 렌더링합니다.
- `useEffect`는 DOM Patch 직후 동기 실행됩니다.
- 이벤트 핸들러를 렌더마다 새로 만들기 때문에 `UPDATE_PROPS` 수가 화면 변화보다 많아질 수 있습니다.
- JSX, Fiber, Concurrent Rendering, Synthetic Event, 서버 렌더링은 구현하지 않았습니다.
- 할 일은 메모리에만 있으며 새로고침하면 초기 상태로 돌아갑니다.
