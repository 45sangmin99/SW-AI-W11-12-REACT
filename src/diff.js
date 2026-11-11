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
// 6번째 종류: DOM을 바꾸지 않는 "핸들러 참조 교체". 함수 props는 렌더링마다 새 클로저라서 !==로 비교하면
// 화면이 그대로인데도 매번 변경으로 잡힌다. 그래서 UPDATE_PROPS와 분리해 두고, 실제 DOM 변경 수에서는 제외한다.
export const REBIND = "REBIND";

/** 실제 DOM을 건드리는 변경만 센다 (REBIND 제외) */
export const countDomChanges = (changes) => changes.filter((c) => c.type !== REBIND).length;

export function diff(oldVdom, newVdom) {
  const changes = [];
  walk(oldVdom, newVdom, [], changes);
  return changes;
}
//1.종류가 다르거나(텍스트↔요소), 둘 다 요소인데 태그 이름이 다르면  이 위치를 새 노드로 통째로 교체
function walk(oldNode, newNode, path, changes) {
  if (oldNode.type !== newNode.type || (oldNode.type === ELEMENT && oldNode.tag !== newNode.tag)) {
    changes.push({ type: REPLACE, path, node: newNode });
    return;
  }
  //2.요소가 아니면(텍스트면) 이전 노드랑 새로운 노드 값 다르면 글자만 바꿔라
  if (oldNode.type !== ELEMENT) {
    if (oldNode.value !== newNode.value) {
      changes.push({ type: UPDATE_TEXT, path, value: newNode.value });
    }
    return;
  }

  const set = {};
  const remove = [];
  const rebind = {};
  // 새 props(속성)를 하나씩 보면서: 이전이랑 값이 다르면(없던 것 포함) set에 담기
  // 단, 이전·새 값이 둘 다 함수면 DOM 변경이 아니므로 rebind에 따로 담는다
  for (const [name, value] of Object.entries(newNode.props)) {
    const prev = oldNode.props[name];
    if (prev === value) continue;
    if (typeof prev === "function" && typeof value === "function") rebind[name] = value;
    else set[name] = value;
  }
  // 이전 props를 하나씩 보면서: 새 props에 그 이름이 아예 없으면 remove에 담기
  for (const name of Object.keys(oldNode.props)) {
    if (!(name in newNode.props)) remove.push(name);
  }
  // 바꿀 게 하나라도 있으면 속성 변경
  if (remove.length || Object.keys(set).length) {
    changes.push({ type: UPDATE_PROPS, path, set, remove });
  }
  if (Object.keys(rebind).length) changes.push({ type: REBIND, path, handlers: rebind });

  const oldKids = oldNode.children;
  const newKids = newNode.children;
  const common = Math.min(oldKids.length, newKids.length);
  // 양쪽에 다 있는 자식들은 같은 번호끼리 짝지어서 walk로 다시 비교 (재귀) 자식한테 위 과정 반복
  for (let i = 0; i < common; i++) walk(oldKids[i], newKids[i], [...path, i], changes);
   // 새 트리에만 있는 자식들(뒤쪽 남는 것) → 부모(path) 끝에 이 노드를 만들어 붙여라
  for (let i = common; i < newKids.length; i++) {
    changes.push({ type: CREATE, path, node: newKids[i] }); // path = 부모, 끝에 추가
  }
  //이전 트리에만 있는 자식들(뒤쪽 남는 것) → 이 위치의 노드 삭제 뒤에서부터 지워야 앞쪽 인덱스가 밀리지 않는다
  for (let i = oldKids.length - 1; i >= common; i--) {
    changes.push({ type: REMOVE, path: [...path, i] });
  }
}
