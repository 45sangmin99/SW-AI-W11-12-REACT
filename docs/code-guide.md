# 코드 읽기 가이드

JavaScript가 처음인 사람이 이 프로젝트의 파일을 읽을 때 필요한 문법, 함수, 전체 지도를 모았다.

## 1. 전체 지도

```
Mini_react/
├─ index.html ........ Phase 1 페이지 (Diff/Patch/History 검증)
├─ voc.html .......... VOC 이상 탐지 페이지 (Phase 2 + 합친 결과물)
├─ test.html ......... 테스트 실행 페이지 (브라우저에서 열면 259개 실행)
├─ data/inquiries.sample.json   샘플 문의 3,000건
├─ scripts/generate-sample.cjs  샘플을 만드는 스크립트 (시드 고정)
│
├─ src/            미니 리액트 본체 (VOC를 몰라도 되는 범용 코드)
│   ├─ vdom.js        DOM → 가상 DOM 변환
│   ├─ diff.js        두 가상 DOM을 비교해 "변경 목록" 만들기
│   ├─ patch.js       변경 목록을 실제 DOM에 적용
│   ├─ dom.js         가상 DOM → 실제 DOM 생성, 속성/이벤트 설정
│   ├─ history.js     뒤로가기/앞으로가기용 상태 기록
│   ├─ mini-react.js  h(), FunctionComponent, useState/useEffect/useMemo, batch
│   └─ main.js        index.html용 연결 코드
│
├─ src/voc/        VOC 주제 코드 (본체를 가져다 씀)
│   ├─ config.js      기준값 모음 (3배, 20건 같은 숫자)
│   ├─ data.js        JSON 불러오기와 검증
│   ├─ analysis.js    이상 탐지 계산 (순수 함수 모음)
│   ├─ pagination.js  페이지 나누기
│   ├─ components.js  화면 조각들 (Header, FilterBar, 카드, 차트 등)
│   ├─ app.js         루트 App (상태와 Hook은 여기만)
│   └─ main.js        voc.html용 연결 코드
│
├─ css/voc.css     디자인
└─ tests/          테스트 (러너 + 파일별 테스트)
```

### 데이터가 흐르는 길

```
JSON
 → data.js        읽고 검증
 → App 상태       저장
 → analysis.js    이상 징후 계산
 → components.js  가상 DOM으로 그림
 → diff           이전 가상 DOM과 비교
 → patch          바뀐 부분만 실제 화면에 반영
```

본체(`src/`)는 VOC를 전혀 모르기 때문에, Step 4에서 다른 주제와 합쳐도 그대로 재사용된다.

## 2. 읽는 순서

1. `voc.html` → `src/voc/main.js` : 시작점 (총 24줄)
2. `src/voc/app.js` : 상태와 흐름 (105줄)
3. `src/voc/components.js` : 화면 조각
4. `src/voc/analysis.js`의 `detectAlerts` : 계산의 핵심. 길어서 부담되면 건너뛰어도 된다
5. `src/mini-react.js` : 발표 직전에 `useState`/`FunctionComponent` 부분만 읽는다

## 3. 반드시 알아야 하는 JS 문법

| 문법 | 의미 | 코드에서 나오는 모양 |
|---|---|---|
| `const` | 다시 대입 못 하는 변수 | `const range = ...` |
| 화살표 함수 | 짧은 함수 | `(a) => a + 1` |
| `import` / `export` | 파일끼리 가져오고 내보내기 | `import { h } from "../mini-react.js"` |
| 배열 구조분해 | 배열에서 꺼내 이름 붙이기 | `const [query, setQuery] = useState("")` |
| 객체 구조분해 | 객체에서 꺼내기 | `const { inquiries, meta } = result` |
| 스프레드 `...` | 펼쳐서 복사·합치기 | `{ ...range, skipCategory: true }` |
| 템플릿 문자열 | 문자열 안에 값 끼우기 | `` `평소의 ${ratio}배` `` |
| `?.` / `??` | 없으면 안전하게 넘어감 / 기본값 | `a ?? b` ("a가 없으면 b") |
| 삼항 연산자 | 짧은 if | `cond ? x : y` |
| `&&`, `\|\|` | 앞이 참/거짓일 때 뒤를 실행 | `loading && h(...)` |
| `Promise` / `async` / `await` | 기다려야 하는 작업 (파일 불러오기) | `await fetch(url)` |
| 클래스 | 상태와 함수를 묶은 틀 | `class FunctionComponent` |

## 4. 반드시 알아야 하는 내장 함수

이 프로젝트의 계산은 대부분 배열 메서드로 되어 있다.

| 함수 | 하는 일 | 예 |
|---|---|---|
| `.map(fn)` | 모든 원소를 변환해 새 배열 | 문의 목록 → 카드 목록 |
| `.filter(fn)` | 조건에 맞는 것만 남김 | 기간 필터, 유형 필터 |
| `.find(fn)` | 조건에 맞는 첫 원소 | 선택한 징후 찾기 |
| `.reduce(fn, 시작값)` | 하나의 값으로 누적 | 시간대별 건수 합산 |
| `.some()` / `.every()` | 하나라도 / 전부 만족하는지 | 검증 |
| `.slice(a, b)` | 일부만 잘라내기 | `iso.slice(0, 13)`로 "시간 단위" 만들기 |
| `.sort(fn)` | 정렬 | 점수순 정렬 |
| `.join(",")` | 배열 → 문자열 | |
| `.includes(x)` | 포함 여부 | 검색 |
| `Map` / `Set` | 키-값 저장 / 중복 없는 모음 | 시간대별 집계, 버전 목록 |
| `Object.freeze` | 수정 못 하게 잠금 | `CONFIG` |
| `Array.from` / `[...set]` | 다른 것을 배열로 | |
| `Math.max/min/ceil/round` | 수학 | 차트 눈금 |
| `fetch` | 파일·API 불러오기 | `data.js` |
| `JSON.parse` | 문자열 → 객체 | |
| `document.createElement` | 실제 DOM 요소 만들기 | `dom.js` |
| `addEventListener` | 클릭 같은 이벤트 연결 | `dom.js` |

## 5. 이 프로젝트의 핵심 함수

### 본체 (`src/`)

| 함수 | 한 줄 설명 |
|---|---|
| `h(tag, props, ...children)` | 가상 DOM 객체를 만든다. 화면 조각은 전부 이것으로 만든다 |
| `FunctionComponent` | 컴포넌트를 실행하고 상태를 들고 있는 틀. `mount()`가 첫 그림, `update()`가 다시 그림 |
| `useState(초기값)` | `[값, 바꾸는 함수]`를 돌려준다. 바꾸면 화면이 다시 그려진다 |
| `useEffect(함수, 의존값)` | 화면이 그려진 뒤 실행할 일 (데이터 불러오기 등) |
| `useMemo(함수, 의존값)` | 의존값이 안 바뀌면 계산을 건너뛰고 이전 결과를 재사용 |
| `batch(fn)` | 여러 `setState`를 묶어 렌더링을 한 번만 한다 |
| `diff(old, new)` | 두 가상 DOM을 비교해 "무엇이 바뀌었나" 목록을 반환 |
| `patch(root, changes)` | 그 목록대로 실제 DOM만 고친다 |
| `render(vnode)` | 가상 DOM → 실제 DOM 요소 |
| `StateHistory` | 상태를 쌓아 두고 뒤로/앞으로 이동 |

### VOC (`src/voc/`)

| 함수 | 한 줄 설명 |
|---|---|
| `detectAlerts` | 이 프로젝트의 두뇌. 전체 시간을 훑어 이상 징후 목록을 만든다 |
| `filterInquiries` | 검색/유형/기기/버전 필터 |
| `summarize` | 요약 카드용 숫자 |
| `normalizePhrase` | 반복 문구를 같은 것으로 보기 위한 정규화 (숫자는 `#` 등) |
| `highlightSegments` | 근거 문의에서 형광펜 칠할 구간 계산 |
| `hourOf`, `eachHour` | 시각을 "시간 단위"로 자르고 시간 목록 만들기 |
| `paginate`, `pageWindow` | 페이지 나누기, 하단 페이지 번호 계산 |
| `parseDataset`, `loadDataset` | JSON 검증과 불러오기 |
| `App` / `mountApp` | 루트 컴포넌트 / 화면에 붙이기 |

## 6. 이해의 열쇠 세 가지

1. **상태 → 파생 값 → 화면.** `app.js`에서 `useState` 10개가 입력이고, `useMemo` 7개가 그 입력에서 `scoped → alerts → visibleAlerts → summary`를 차례로 계산한다. 마지막 `h(...)`가 이 값들을 자식에게 props로 내려보낸다.
2. **자식은 순수 함수.** `components.js`의 컴포넌트는 상태가 없고 `props → 가상 DOM`만 한다. 클릭 같은 사건은 부모가 준 `onSelect` 같은 함수를 호출해 위로 올린다 (Lifting State Up).
3. **Hook은 호출 순서로 기억한다.** `FunctionComponent.hooks` 배열에 호출 순서대로 값이 쌓이고, 다시 그릴 때 같은 순서로 꺼낸다. 그래서 Hook을 `if` 안에 넣으면 안 된다.
