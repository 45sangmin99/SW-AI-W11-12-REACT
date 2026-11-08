// Patch (P1-03): Diff가 만든 변경 목록을 실제 DOM에 반영한다.
// 변경된 노드만 건드리고 나머지 노드는 그대로 유지한다.
import { render, setProp, removeProp, childNamespace } from "./dom.js";
import { childContainer } from "./vdom.js";
import { CREATE, REMOVE, REPLACE, UPDATE_PROPS, UPDATE_TEXT } from "./diff.js";

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
    const target = resolve(root, change.path);
    switch (change.type) {
      case CREATE:
        childContainer(target).appendChild(render(change.node, childNamespace(target)));
        break;
      case REMOVE:
        target.remove();
        break;
      case REPLACE: {
        const parent = target.parentNode;
        const next = render(change.node, parent && parent.nodeType === Node.ELEMENT_NODE ? childNamespace(parent) : null);
        target.replaceWith(next);
        if (change.path.length === 0) root = next;
        break;
      }
      case UPDATE_PROPS:
        for (const name of change.remove) removeProp(target, name);
        for (const [name, value] of Object.entries(change.set)) setProp(target, name, value);
        break;
      case UPDATE_TEXT:
        target.nodeValue = change.value;
        break;
    }
  }
  return root;
}
