# MINI REACT

## 개요

Vanilla JavaScript로 구현한 학습용 UI 라이브러리입니다.

함수형 컴포넌트와 Hook으로 화면의 상태를 관리하고, Virtual DOM을 비교해 실제 DOM에 변경을 반영합니다. 코드 편집과 Patch를 실험하는 플레이그라운드, 물류 시뮬레이터, 고객 문의(VOC) 탐지 화면으로 구현 내용을 확인할 수 있습니다.

## 설계 목표

브라우저의 DOM API만으로 화면을 만들 수 있습니다. 다만 하나의 상태가 여러 요소에 영향을 주면, 상태를 바꾸는 코드마다 갱신할 요소를 직접 찾아야 합니다.

- 컴포넌트가 현재 상태의 화면을 표현하면, 엔진이 이전 화면과 비교해 바뀐 곳을 찾습니다.
- 목록의 순서가 바뀌어도 같은 항목의 DOM을 재사용해 입력값·포커스와 같은 브라우저 상태를 보존합니다.
- 코드 수정에 실패하면 편집 전 화면과 실행 상태를 계속 사용할 수 있게 합니다.

## 특징

### 1. Virtual DOM과 Diff·Patch

- 브라우저 DOM이나 `h()`의 결과를 비교할 수 있는 트리로 다룹니다. 노드의 타입·텍스트·속성·자식을 비교하고 필요한 DOM 변경을 계산합니다.

#### 도입 이유

- 화면 전체를 다시 만들면 그대로인 요소와 이벤트 연결도 교체됩니다. 특히 순서가 바뀐 목록을 위치로만 비교하면, 같은 데이터 항목과 기존 DOM이 서로 어긋날 수 있습니다.

#### 적용 방식

- 텍스트·속성 변경과 자식 추가·삭제·이동을 Patch로 나눕니다.
- 형제 사이의 고유한 `key`로 목록 항목을 찾습니다. 이동하면서 내용이 바뀌어도 해당 항목의 기존 노드에 변경을 적용합니다.
- 폼의 `value`와 `checked`는 DOM 속성뿐 아니라 브라우저가 사용 중인 프로퍼티도 맞춥니다. 제거된 노드와 교체된 핸들러의 이벤트 연결을 정리합니다.

### 2. 함수형 컴포넌트와 Hook

- `useState`로 상태를 유지하고, `useMemo`로 계산 결과를 재사용하며, `useEffect`로 DOM 반영 뒤 외부 동작과 정리를 처리합니다.

#### 도입 이유

- 상태 변화와 DOM 갱신을 분리하면 화면을 만드는 함수에서 변경 대상을 일일이 지정할 필요가 줄어듭니다. 연속된 상태 변경을 한 번에 반영하면 같은 화면을 여러 번 계산하는 비용도 줄일 수 있습니다.

#### 적용 방식

- 루트 컴포넌트에 Hook을 호출 순서대로 저장합니다. 자식 컴포넌트는 props를 받는 함수로 실행합니다.
- 값이 바뀌면 microtask에서 갱신합니다. 같은 실행 구간에서 여러 번 호출된 setter를 한 번의 갱신으로 묶고, 같은 값의 설정은 생략합니다.
- 새 트리를 적용한 뒤 effect를 실행합니다. 의존값이 바뀌거나 컴포넌트가 해제되면 이전 effect를 정리합니다.

### 3. 플레이그라운드와 실행 이력

- 코드 편집, 자동 반영, 수동 Patch, 뒤로 가기·앞으로 가기, DOM 변경 표시를 제공합니다.

#### 도입 이유

- 코드를 직접 바꿔 결과를 확인할 때 미리보기 전체가 새로 열리면, 보존해야 할 상태와 실제로 바뀐 요소를 비교하기 어렵습니다.

#### 적용 방식

- 미리보기를 iframe에서 실행하고, 호환되는 코드 변경은 같은 프리뷰에 적용합니다.
- 성공한 코드 적용 시점의 실행 상태와 VDOM을 이력으로 관리합니다. 오류가 나면 마지막으로 정상 실행된 화면에 오류를 표시합니다.
- DOM 갱신 표시를 켜면 요소 경계와 최근에 Patch가 적용된 대상을 확인할 수 있습니다.

## 실행

Node.js 22 이상과 Python 3이 필요합니다. Node 패키지는 테스트에 사용합니다.

```sh
npm ci
python3 dev_server.py
```

브라우저에서 `http://127.0.0.1:8000/`을 엽니다.

| 화면 | 주소 | 확인할 내용 |
| --- | --- | --- |
| 플레이그라운드 | `/` | 코드 편집, 상태 이력, DOM 갱신 표시 |
| Virtual DOM·Hook 실습 | `/examples/labs-logistics/` | Patch 명령, DOM 재사용, 할 일 목록의 상태와 Hook |
| 물류 시뮬레이터 | `/examples/labs-logistics/logistics.html` | 이동·배차·배송 상태와 이력 복원 |
| OBJECT NOTE VOC | `/examples/object-note/voc.html?source=sample` | 샘플 문의의 급증, 유형 쏠림, 기기·버전 쏠림, 반복 문구 |

별도 프로젝트였던 두 예제의 엔진과 API는 각 예제 안에 보존합니다. 새 UI에서 사용하는 라이브러리 진입점은 `src/mini-react/index.js`입니다. 예제의 자세한 사용법과 구현을 확인할 수 있습니다. [실습·물류 시뮬레이터](examples/labs-logistics/README.md) · [OBJECT NOTE](examples/object-note/README.md)

### VOC 서비스와 저장소 연결

샘플 화면은 브라우저에서 문의를 분석합니다. DB 연결 모드는 Node 서비스에서 조회 조건을 처리해 DBMS의 문의를 분석하고, 조회 결과를 Redis에 캐시합니다. 진행 상태를 저장한 뒤에는 상태 캐시를 갱신합니다.

```sh
cd examples/object-note
./tools/start-all.sh
```

`http://127.0.0.1:8001/voc.html`에서 엽니다. 기본 스크립트는 예제에 포함된 DBMS와 Redis를 빌드하고 시연용 데이터를 준비합니다. `DB_BIN`, `DB_CLI`, `REDIS_BIN`에 각각 해당 바이너리의 절대 경로를 주면 별도 체크아웃에서 빌드한 버전을 연결할 수 있습니다. [서비스 실행과 API](examples/object-note/README.md#db와-연결해-실행)

## 지원 API

| API | 역할 |
| --- | --- |
| `h(type, props, ...children)` | 요소 또는 함수형 컴포넌트를 표현 |
| `FunctionComponent` | 루트의 `mount()`, `update()`, `unmount()` 관리 |
| `useState(initial)` | 상태와 setter 제공. 연속 변경은 microtask 단위로 묶어 갱신 |
| `useEffect(effect, deps)` | DOM 반영 후 실행. 의존값 변경·unmount 시 cleanup |
| `useMemo(factory, deps)` | 의존값이 같으면 계산 결과 재사용 |
| `domToVDOM(node)` / `createDOM(vnode, document)` | DOM과 Virtual DOM 사이 변환 |
| `diff(previous, next)` / `patch(root, changes)` | 변경 탐색과 DOM 반영 |

Hook은 루트 컴포넌트의 최상위에서 같은 순서로 호출합니다. 이동하는 목록에는 형제 사이에서 유일하고 안정적인 `key`를 지정합니다. [key의 동작과 제약](./src/mini-react/readme.md)을 확인할 수 있습니다.

## 사용 예제

잔액과 강화 레벨을 하나의 상태로 관리합니다. 강화 버튼을 누르면 잔액·공격력·버튼의 구매 가능 여부가 함께 갱신됩니다.

```html
<div id="root"></div>

<script type="module">
  import { h, FunctionComponent, useState } from './src/mini-react/index.js';

  function UpgradeButton({ canBuy, onBuy }) {
    return h('button', { disabled: !canBuy, onClick: onBuy }, '강화 · 10원');
  }

  function App() {
    const [player, setPlayer] = useState({ money: 30, level: 1 });

    function upgrade() {
      setPlayer(previous => previous.money < 10 ? previous : {
        money: previous.money - 10,
        level: previous.level + 1,
      });
    }

    return h('main', {},
      h('p', {}, `잔액: ${player.money}원`),
      h('p', {}, `공격력: ${player.level * 10}`),
      h(UpgradeButton, { canBuy: player.money >= 10, onBuy: upgrade }),
    );
  }

  new FunctionComponent(App, document.getElementById('root')).mount();
</script>
```

예제는 이 저장소 루트에서 제공하는 HTML 기준입니다. JSX 변환 없이 `h()`로 화면을 작성합니다. 루트가 상태를 소유하고 자식 컴포넌트는 props만 사용합니다.

## 검증

```sh
npm test
npm run test:python
npm run test:voc
python3 scripts/test-voc-http.py
```

| 검증 | 결과 | 확인한 내용 |
| --- | ---: | --- |
| Node 엔진·실습 테스트 | 112개 통과 | Hook, Patch, 폼 상태, DOM 재사용, 이력과 물류 화면 |
| Python 개발 서버 테스트 | 11개 통과 | 예제 경로, 게임 진행·아이템 API |
| Chromium VOC 테스트 | 316개 통과 | DOM 변경, iframe 이력, 화면 배치, 문의 탐지와 서비스 응답 |
| 실제 VOC HTTP 연결 | 통과 | DBMS 응답, Redis 캐시 적중, 상태 저장 뒤 캐시 무효화 |

브라우저 자동 테스트에는 Chrome 또는 Chromium이 필요합니다. 설치 경로가 다르면 `npm run test:voc -- --browser /path/to/chromium`으로 지정합니다. VOC HTTP 검증은 생성한 임시 데이터와 독립 포트를 사용합니다. 같은 검사에서 최신 Mini DBMS와 통합 Mini Redis 바이너리도 연결해 확인했습니다.

## 구현 범위

루트 라이브러리는 함수형 컴포넌트와 루트 Hook, VDOM 비교·DOM Patch를 지원합니다. JSX 변환, Fiber, 서버 렌더링은 범위 밖입니다. 외부 `Mini Project`의 전체 게임 화면과 캐릭터 엔진 실행에는 해당 프로젝트와 별도 런타임이 필요합니다.

## 통합 기준

| 예제 | 가져온 브랜치 | 위치 |
| --- | --- | --- |
| 플레이그라운드·공용 엔진 | `sangmin` (`d3f4e3d`) 및 작업 폴더 변경 | `src/mini-react/`, `index.html` |
| 실습·물류 | `develop_nuri` (`4d2552c`) | `examples/labs-logistics/` |
| VOC 브라우저·서비스 | `hyeonju` (`d38ecdb`) | `examples/object-note/` |
