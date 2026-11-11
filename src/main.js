// Phase 1 검증 페이지 (P1-10 ~ P1-21)
import { containerToVdom, htmlToVdom, cleanContainer } from "./vdom.js";
import { render } from "./dom.js";
import { diff } from "./diff.js";
import { patch } from "./patch.js";
import { StateHistory } from "./history.js";
//document.getElementById:[내장] htmld에서 id가 일치하는 요소 하나를 찾아서 돌려줌
const realRoot = document.getElementById("real-root");
const testRoot = document.getElementById("test-root");
const testCode = document.getElementById("test-code");
const patchBtn = document.getElementById("patch-btn");
const backBtn = document.getElementById("back-btn");
const forwardBtn = document.getElementById("forward-btn");

// P1-13: 로드 시 실제 영역의 샘플 HTML을 Virtual DOM으로 변환
// cleanContainer 제외 노드(주석, <script>)를 먼저 지워서 Virtual DOM 인덱스와 실제 DOM 인덱스를 맞춘다 
cleanContainer(realRoot);
let currentVdom = containerToVdom(realRoot);
// containerToVdom:실제 DOM 요소를 읽어서 Virtual DOM(자바스크립트 객체)으로 바꿈
const history = new StateHistory(currentVdom);

/** 테스트 영역을 주어진 Virtual DOM으로 그리고, 코드 편집 칸도 같은 내용으로 맞춘다 // function 함수이름(매개변수) { ... }: 함수 정의. vdom을 받아서 화면에 그리는 역할*/
function showInTestArea(vdom) {
  testRoot.replaceChildren(...vdom.children.map((child) => render(child)));
  testCode.value = testRoot.innerHTML;
}

// P1-14: 방금 만든 Virtual DOM으로 테스트 영역 렌더링
showInTestArea(currentVdom);

// P1-15: 코드 편집 칸을 수정하면 테스트 영역 미리보기가 바뀐다
testCode.addEventListener("input", () => {
  const edited = htmlToVdom(testCode.value);
  testRoot.replaceChildren(...edited.children.map((child) => render(child)));
});

function updateButtons() {
  backBtn.disabled = !history.canBack;
  forwardBtn.disabled = !history.canForward;
}

// P1-16 ~ P1-19
patchBtn.addEventListener("click", () => {
  const next = containerToVdom(testRoot);
  const changes = diff(currentVdom, next);
  if (changes.length === 0) return; // U-06: 변경이 없으면 기록을 추가하지 않는다
  patch(realRoot, changes);
  history.push(next);
  currentVdom = next;
  updateButtons();
});

// P1-20, P1-21: 실제 영역과 테스트 영역을 함께 이동
function moveTo(target) {
  if (!target) return;
  patch(realRoot, diff(currentVdom, target));
  showInTestArea(target);
  currentVdom = target;
  updateButtons();
}
backBtn.addEventListener("click", () => moveTo(history.back()));
forwardBtn.addEventListener("click", () => moveTo(history.forward()));

updateButtons();
