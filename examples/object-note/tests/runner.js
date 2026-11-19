// 직접 만든 최소 테스트 러너 (외부 라이브러리 없음). 브라우저에서 test.html을 열어 실행한다.
import { isUnsafeAttr } from "../src/dom.js";
import { childContainer } from "../src/vdom.js";

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  current.tests.push({ name, fn });
}

// ---- 단언 ----
const fmt = (v) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "function" ? "[function]" : String(v));

export function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}
export function eq(actual, expected, msg = "eq") {
  if (!Object.is(actual, expected)) throw new Error(`${msg}: expected ${fmt(expected)}, got ${fmt(actual)}`);
}
export function deepEq(actual, expected, msg = "deepEq") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
export function throws(fn, pattern) {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error("예외가 발생해야 하는데 발생하지 않았습니다.");
  if (pattern && !pattern.test(error.message)) {
    throw new Error(`예외 메시지가 ${pattern}와 맞지 않습니다: ${error.message}`);
  }
  return error;
}

// ---- 도우미 ----
export function mk(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 객체가 깊게 얼려졌는지 (자식, props, children 배열 포함) */
export function isDeepFrozen(vnode) {
  if (!Object.isFrozen(vnode)) return false;
  if (vnode.props && !Object.isFrozen(vnode.props)) return false;
  if (vnode.children) {
    if (!Object.isFrozen(vnode.children)) return false;
    return vnode.children.every(isDeepFrozen);
  }
  return true;
}

/**
 * "Virtual DOM 자식 인덱스 == 실제 DOM 자식 인덱스"가 지켜지는지 검사한다.
 * 노드 수, 종류, 태그, 텍스트, (차단 대상이 아닌) 문자열 속성을 비교한다.
 */
export function assertMirrors(dom, vnode, path = "root") {
  if (vnode.type === "text") {
    eq(dom.nodeType, Node.TEXT_NODE, `${path} 노드 종류`);
    eq(dom.nodeValue, vnode.value, `${path} 텍스트`);
    return;
  }
  eq(dom.nodeType, Node.ELEMENT_NODE, `${path} 노드 종류`);
  eq(dom.localName, vnode.tag, `${path} 태그`);
  for (const [name, value] of Object.entries(vnode.props)) {
    if (typeof value !== "string" || name.startsWith("on") || isUnsafeAttr(name, value)) continue;
    if (name === "value" || name === "checked") continue;
    eq(dom.getAttribute(name), value, `${path} 속성 ${name}`);
  }
  const kids = childContainer(dom).childNodes; // <template>은 content 안
  eq(kids.length, vnode.children.length, `${path} 자식 수`);
  vnode.children.forEach((child, i) => assertMirrors(kids[i], child, `${path}/${i}`));
}

// ---- 실행·출력 ----
export async function runAll(output) {
  let passed = 0;
  let failed = 0;
  const frag = document.createDocumentFragment();

  for (const suite of suites) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = suite.name;
    const list = document.createElement("ul");
    section.append(title, list);

    for (const test of suite.tests) {
      const item = document.createElement("li");
      try {
        await test.fn();
        passed++;
        item.className = "pass";
        item.textContent = `PASS  ${test.name}`;
      } catch (error) {
        failed++;
        item.className = "fail";
        item.textContent = `FAIL  ${test.name} — ${error.message}`;
        console.error(`[${suite.name}] ${test.name}`, error);
      }
      list.appendChild(item);
    }
    frag.appendChild(section);
  }

  const summary = document.createElement("p");
  summary.id = "summary";
  summary.className = failed ? "fail" : "pass";
  summary.textContent = `${passed + failed}개 중 ${passed}개 통과, ${failed}개 실패`;
  output.replaceChildren(summary, frag);
  document.title = failed ? `FAIL (${failed})` : `ALL PASS (${passed})`;
  return { passed, failed };
}
