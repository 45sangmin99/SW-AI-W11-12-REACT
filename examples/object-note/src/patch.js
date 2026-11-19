// Patch (P1-03): Diff가 만든 변경 목록을 실제 DOM에 반영한다.
// 변경된 노드만 건드리고 나머지 노드는 그대로 유지한다.
import { render, setProp, removeProp, rebindHandler, childNamespace } from "./dom.js";
import { childContainer } from "./vdom.js";
import { CREATE, REMOVE, REPLACE, UPDATE_PROPS, UPDATE_TEXT, REBIND } from "./diff.js";
// path(예: [0, 0])를 따라 루트에서 한 칸씩 내려가서 실제 DOM 노드를 찾아 돌려준다
function resolve(rootEl, path) {
  let node = rootEl;
  for (const index of path) {
    node = childContainer(node).childNodes[index];
    if (!node) throw new Error(`Patch 경로를 찾을 수 없습니다: [${path.join(", ")}]`);
  }
  return node;
}

/**
 * @param rootEl  변경 목록의 기준이 되는 루트 DOM 요소
 * @returns       패치 후의 루트 요소 (루트가 교체되면 새 요소, 아니면 그대로)
 */
export function patch(rootEl, changes) {
  let root = rootEl;
  for (const change of changes) {
    const target = resolve(root, change.path);// 1) 고칠 노드 찾아가기
    switch (change.type) {
      case CREATE:
        childContainer(target).appendChild(render(change.node, childNamespace(target)));// target = 부모. 새 노드를 실제로 만들어서 부모 맨 끝에 붙임
        break;
      case REMOVE:
        target.remove();// target 자기 자신을 DOM에서 떼어냄
        break;
      case REPLACE: {// 새 노드를 실제로 만들어서 target 자리에 갈아끼움
        const parent = target.parentNode;
        const next = render(change.node, parent && parent.nodeType === Node.ELEMENT_NODE ? childNamespace(parent) : null);
        target.replaceWith(next);
        if (change.path.length === 0) root = next;
        break;
      }
      case UPDATE_PROPS:// 지울 속성 먼저 지우고, 넣을/바꿀 속성 넣기
        for (const name of change.remove) removeProp(target, name);
        for (const [name, value] of Object.entries(change.set)) setProp(target, name, value);
        break;
      case REBIND:// 리스너는 그대로 두고, 호출할 최신 핸들러만 교체 (DOM은 변하지 않음)
        for (const [name, fn] of Object.entries(change.handlers)) rebindHandler(target, name, fn);
        break;
      case UPDATE_TEXT:// 텍스트 노드의 글자만 바꿈
        target.nodeValue = change.value;
        break;
    }
  }
  return root;
}
