// Virtual DOM -> 실제 DOM 생성, 속성 적용 (render / setProp / removeProp)
import { TEXT, childContainer } from "./vdom.js";

export const SVG_NS = "http://www.w3.org/2000/svg";

// 요소별로 붙인 이벤트 핸들러: el -> { onClick: { fn, listener }, ... }
//   listener : DOM에 실제로 붙는 "안정적인" 함수. 요소당 이벤트당 한 번만 붙이고 떼기 전까지 바뀌지 않는다.
//   fn       : listener가 호출할 "최신" 핸들러. 렌더링마다 새로 만들어지는 클로저로 갈아끼운다 (rebindHandler).
const handlers = new WeakMap();

const isHandlerName = (name) => name.length > 2 && name.startsWith("on");
const eventName = (name) => name.slice(2).toLowerCase();

// 핸들러를 실행하는 방식. 기본은 그냥 실행. Phase 2(mini-react.js)가 batch로 바꿔 끼운다:
// 핸들러 안의 setState를 모아서 핸들러가 끝난 뒤 한 번만 렌더링하기 위함 (O-01).
let eventRunner = (run) => run();
export function setEventRunner(runner) {
  eventRunner = typeof runner === "function" ? runner : (run) => run();
}

/** 핸들러 연결·갱신. 처음이면 안정적인 리스너를 붙이고, 이미 있으면 호출 대상(최신 함수)만 바꾼다 */
function bindHandler(el, name, fn) {
  const map = handlers.get(el) ?? {};
  handlers.set(el, map);
  if (map[name]) {
    map[name].fn = fn; // 리스너는 그대로: 떼었다 붙이지 않는다
    return;
  }
  const entry = { fn, listener: null };
  entry.listener = (event) => eventRunner(() => entry.fn.call(el, event));
  map[name] = entry;
  el.addEventListener(eventName(name), entry.listener);
}

/** 이미 같은 이름의 핸들러가 붙어 있는 요소의 호출 대상만 최신 함수로 교체 (Diff의 REBIND용) */
export function rebindHandler(el, name, fn) {
  if (typeof fn !== "function") return;
  bindHandler(el, name, fn);
}

/** 부모 요소 기준으로 자식이 만들어질 네임스페이스 */
export function childNamespace(parentEl) {
  return parentEl.namespaceURI === SVG_NS && parentEl.localName !== "foreignObject" ? SVG_NS : null;
}

export function render(vnode, ns = null) {
  if (vnode.type === TEXT) return document.createTextNode(vnode.value);

  const elNs = vnode.tag === "svg" ? SVG_NS : ns;
  const el = elNs ? document.createElementNS(elNs, vnode.tag) : document.createElement(vnode.tag);
  const childNs = vnode.tag === "foreignObject" ? null : elNs;
  const host = childContainer(el); // <template>이면 content에 붙인다
  for (const child of vnode.children) host.appendChild(render(child, childNs));
  // <select value>가 동작하도록 자식(option)을 붙인 뒤 속성을 적용한다
  for (const [name, value] of Object.entries(vnode.props)) setProp(el, name, value);
  return el;
}

// 차단 범위 (모든 위험한 입력을 막는 것이 아니다. 아래에 정한 속성·값만 차단한다):
//   - srcdoc 속성
//   - 아래 URL 속성에 들어간 javascript:, vbscript:, data:text/html 값
//     (SVG의 href, xlink:href 포함)
// 정하지 않은 경로는 처리하지 않는다. 예: SVG <animate values="javascript:...">,
// style 속성, <meta http-equiv="refresh">, 목록 밖의 URL 속성.
const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "data", "poster", "background", "xlink:href", "cite", "longdesc",
]);

const XLINK_NS = "http://www.w3.org/1999/xlink";

/** 위 차단 범위에 해당하는 속성인가 */
export function isUnsafeAttr(name, value) {
  const n = name.toLowerCase();
  if (n === "srcdoc") return true;
  if (!URL_ATTRS.has(n)) return false;
  // 브라우저는 URL 안의 공백·제어문자를 무시하므로 모두 지우고 비교한다 ("java\tscript:" 우회 방지)
  const v = String(value).replace(/[\u0000- ]/g, "").toLowerCase();
  return v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html");
}

export function setProp(el, name, value) {
  if (isHandlerName(name)) {
    // 함수만 이벤트로 연결한다. 문자열 onclick="..."은 코드 실행이므로 무시하고,
    // 함수였던 핸들러가 문자열로 바뀌면 이전 리스너를 지운다 (U-08)
    if (typeof value !== "function") {
      removeProp(el, name);
      return;
    }
    bindHandler(el, name, value);
    return;
  }
  if (isUnsafeAttr(name, value)) {
    removeProp(el, name); // 이전의 안전한 값이 남지 않게 속성 자체를 제거
    return;
  }
  if (name === "value" || name === "checked") {
    // 속성(domToVdom이 읽는 값)과 프로퍼티(화면에 보이는 값)를 함께 맞춘다
    if (name === "value") {
      el.setAttribute("value", value);
      if (el.value !== value) el.value = value;
    } else {
      el.setAttribute("checked", "");
      el.checked = true;
    }
    return;
  }
  // xlink:* 는 네임스페이스가 있어야 SVG에서 동작한다 (setAttribute는 이름만 붙인 속성을 만든다)
  if (name.startsWith("xlink:")) el.setAttributeNS(XLINK_NS, name, value);
  else el.setAttribute(name, value);
}

export function removeProp(el, name) {
  if (isHandlerName(name)) {
    const map = handlers.get(el);
    if (map && map[name]) {
      el.removeEventListener(eventName(name), map[name].listener);
      delete map[name];
    }
    return;
  }
  if (name.startsWith("xlink:")) el.removeAttributeNS(XLINK_NS, name.slice(6));
  else el.removeAttribute(name);
  if (name === "value" && "value" in el) el.value = "";
  if (name === "checked" && "checked" in el) el.checked = false;
}
