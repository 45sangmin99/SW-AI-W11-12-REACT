# 미니 React

Vanilla JavaScript로 Virtual DOM·Diff·Patch, 함수형 컴포넌트와 `useState`·`useEffect`·`useMemo`를 구현한다. Hook과 상태는 루트 컴포넌트에서 관리하며 자식은 props를 받는 순수 함수다.

## 실행

```sh
npm install
python3 dev_server.py
```

접속: http://localhost:8000/

## 구성

- `src/mini-react/`: 게임과 플레이그라운드가 함께 사용하는 VDOM·Diff·Patch·컴포넌트·Hooks 및 선택적 DOM 갱신 표시.
- `index.html`, `src/app.js`: 코드 편집과 iframe 미리보기를 제공하는 플레이그라운드. 자동 반영·수동 Patch·뒤로가기·앞으로가기를 지원한다.
- `src/example.js`: 플레이그라운드의 기본 길찾기 예제.
- `src/playground.js`, `src/preview-controller.js`: 코드 적용과 미리보기 실행 수명 관리.
- `src/history.js`: 성공한 코드 적용 시점의 VDOM·실행 상태 기록과 복원. 일반 상태 변경마다 기록하는 기능은 아니다.
- `src/dom-debug-host.js`: 앱 밖에 선택적으로 연결하는 DOM 갱신 표시 컨트롤.
- `dev_server.py`: 개발 서버와 미니프로젝트·엔진 정적 자원 경로.
- `tests/`: 공용 구현·플레이그라운드·개발 서버 검증.

게임은 이 저장소 옆의 `Mini Project`에서 이 mini-react를 import해 실행한다.

## 상태 갱신

`useState`의 setter → 루트 함수 재실행 → 새 VDOM → 이전 VDOM과 Diff → 변경된 DOM에 Patch 순서로 진행한다. `useEffect`는 외부 시스템 연결과 정리를, `useMemo`는 의존값이 같은 계산 결과의 재사용을 담당한다.

History 복원은 DOM만 교체하지 않고 컴포넌트 상태·이전 VDOM·이벤트 및 Effect 수명도 함께 맞춰야 다음 상호작용이 복원한 상태에서 이어진다. 세부 구현은 `src/history.js`, `src/preview-controller.js`와 관련 테스트를 따른다.

## 검증

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
```

`package.json`의 `type: module`은 Node의 ES module 실행을, `jsdom`은 DOM 기반 테스트를 지원한다. jsdom 테스트는 실제 브라우저의 레이아웃·페인트 검증을 대신하지 않는다.

공용 구현 설명은 `src/mini-react/readme.md`에 있다. 현재 플레이그라운드는 소스 편집·실행 방식이며, 과제 원문의 실제/테스트 DOM 두 영역을 직접 편집하는 화면과는 다르다. 사용하지 않는 독립 DOM 편집 실험 페이지와 전용 코드는 제거했다.
