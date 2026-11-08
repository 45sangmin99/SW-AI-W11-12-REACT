// Diff 알고리즘 (P1-02)
// 두 Virtual DOM을 비교해 "변경 목록"을 만든다. 5가지 핵심 케이스(U-03):
//   CREATE       노드 추가
//   REMOVE       노드 삭제
//   REPLACE      노드 타입(태그/종류) 교체
//   UPDATE_PROPS 속성 변경
//   UPDATE_TEXT  텍스트 변경
// 자식은 key 없이 인덱스 순서대로 비교한다 (U-01).
// 주의: 순서가 바뀌어도 노드를 "이동"하지 않고 각 위치의 내용을 수정할 뿐이다.
//       따라서 순서 변경 시 DOM 노드 동일성이나 포커스 보존은 보장하지 않는다.
// path: 루트에서 시작하는 자식 인덱스 배열 ([] = 루트, [0,2] = 루트의 0번째 자식의 2번째 자식)
import { ELEMENT } from "./vdom.js";

export const CREATE = "CREATE";
export const REMOVE = "REMOVE";
export const REPLACE = "REPLACE";
export const UPDATE_PROPS = "UPDATE_PROPS";
export const UPDATE_TEXT = "UPDATE_TEXT";

export function diff(oldVdom, newVdom) {
  const changes = [];
  walk(oldVdom, newVdom, [], changes);
  return changes;
}

function walk(oldNode, newNode, path, changes) {
  if (oldNode.type !== newNode.type || (oldNode.type === ELEMENT && oldNode.tag !== newNode.tag)) {
    changes.push({ type: REPLACE, path, node: newNode });
    return;
  }

  if (oldNode.type !== ELEMENT) {
    if (oldNode.value !== newNode.value) {
      changes.push({ type: UPDATE_TEXT, path, value: newNode.value });
    }
    return;
  }

  const set = {};
  const remove = [];
  for (const [name, value] of Object.entries(newNode.props)) {
    if (oldNode.props[name] !== value) set[name] = value;
  }
  for (const name of Object.keys(oldNode.props)) {
    if (!(name in newNode.props)) remove.push(name);
  }
  if (remove.length || Object.keys(set).length) {
    changes.push({ type: UPDATE_PROPS, path, set, remove });
  }

  const oldKids = oldNode.children;
  const newKids = newNode.children;
  const common = Math.min(oldKids.length, newKids.length);
  for (let i = 0; i < common; i++) walk(oldKids[i], newKids[i], [...path, i], changes);

  for (let i = common; i < newKids.length; i++) {
    changes.push({ type: CREATE, path, node: newKids[i] }); // path = 부모, 끝에 추가
  }
  // 뒤에서부터 지워야 앞쪽 인덱스가 밀리지 않는다
  for (let i = oldKids.length - 1; i >= common; i--) {
    changes.push({ type: REMOVE, path: [...path, i] });
  }
}
