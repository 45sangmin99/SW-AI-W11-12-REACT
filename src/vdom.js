// Virtual DOM 변환 (P1-01)
// 요소: { type: "element", tag, props, children }
// 텍스트: { type: "text", value }
// 공백 텍스트는 보존하고, 주석과 <script>는 제외한다 (U-07, U-08).

export const ELEMENT = "element";
export const TEXT = "text";

/** 실제 DOM 노드 하나를 Virtual DOM 노드로 변환한다. 제외 대상이면 null. */
export function domToVdom(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return { type: TEXT, value: node.nodeValue };
  }//종류:텍스트 내용: 그 글자 반환
  if (node.nodeType !== Node.ELEMENT_NODE) return null; 
  const tag = node.localName; 
  if (tag === "script") return null;

  const props = {};
  for (const attr of node.attributes) props[attr.name] = attr.value;//이름: 값 형태로 props에 넣기

  return { type: ELEMENT, tag, props, children: childrenToVdom(childContainer(node).childNodes) };
}//{ 종류: 요소, 태그 이름, 속성 상자, 자식들 } 객체를 만들어서 돌려주는데 자식 하나하나도 childrenToVdom 함수로 변환한 결과를 받아서 맨위 노드 하나만 넣으면 트리 전체 객체로 바뀌게

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * 자식이 실제로 들어 있는 노드를 돌려준다.
 * <template>의 내용은 요소의 childNodes가 아니라 template.content(DocumentFragment)에 있다.
 * Virtual DOM의 children은 이 위치와 1:1로 대응한다.
 */
export function childContainer(el) {
  return el.localName === "template" && el.namespaceURI === HTML_NS && el.content ? el.content : el;
}

function childrenToVdom(nodeList) {
  const children = [];
  let dropped = false; // 직전에 주석/<script>를 건너뛰었는가
  for (const child of nodeList) {
    const vnode = domToVdom(child);
    if (!vnode) {
      dropped = true;
      continue;
    }
    const last = children[children.length - 1];
    // "a<!--x-->b"처럼 제외 노드 때문에 맞붙은 텍스트는 하나로 합친다.
    // (렌더링하면 텍스트 노드 하나가 되므로 DOM 인덱스와 맞는다)
    if (dropped && vnode.type === TEXT && last?.type === TEXT) last.value += vnode.value;
    else children.push(vnode);
    dropped = false;
  }
  return children;
}

/**
 * Virtual DOM에서 제외하는 노드(주석, <script>)를 실제 DOM에서도 지운다.
 * 제외 노드가 남아 있으면 "Virtual DOM 자식 인덱스 == 실제 DOM 자식 인덱스"가 깨져
 * 엉뚱한 노드를 패치하게 된다. 정적 HTML을 처음 Virtual DOM으로 만들기 전에 호출한다.
 * normalize()로 맞붙은 텍스트 노드를 합치고 빈 텍스트 노드를 없앤다.
 */
export function cleanContainer(container) {
  const remove = [];
  const templates = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE || n.localName === "script") remove.push(n);
    else if (childContainer(n) !== n) templates.push(n); // TreeWalker는 template.content 안으로 들어가지 못한다
  }
  for (const n of remove) n.remove();
  for (const t of templates) cleanContainer(t.content);
  container.normalize();
}

/** Virtual DOM을 재귀적으로 얼려 이후의 직접 수정을 막는다 (히스토리 스냅샷 보호) */
export function deepFreeze(vnode) {
  if (Object.isFrozen(vnode)) return vnode;
  Object.freeze(vnode.props);
  if (vnode.children) {
    for (const child of vnode.children) deepFreeze(child);
    Object.freeze(vnode.children);
  }
  return Object.freeze(vnode);
}

/**
 * 컨테이너의 "내용물"을 Virtual DOM 트리로 변환한다.
 * 컨테이너 자신의 id·class 등은 비교 대상이 아니므로 루트는 항상 props가 빈 div다.
 */
export function containerToVdom(container) {
  return { type: ELEMENT, tag: "div", props: {}, children: childrenToVdom(container.childNodes) };
}

/**
 * HTML 문자열을 Virtual DOM으로 변환한다.
 * <template>의 content는 비활성 문서라서 스크립트·이미지 로딩이 일어나지 않는다.
 */
export function htmlToVdom(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return { type: ELEMENT, tag: "div", props: {}, children: childrenToVdom(template.content.childNodes) };
}
