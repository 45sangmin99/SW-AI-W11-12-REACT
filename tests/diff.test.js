import assert from "node:assert/strict";
import { test } from "node:test";
import { diff } from "../src/diff.js";

function h(type, props = {}, children = []) {
  return { type, props, children };
}

test("같은 트리에는 변경 명령이 없다", () => {
  const tree = h("p", { class: "message" }, ["Hello"]);
  assert.deepEqual(diff(tree, structuredClone(tree)), []);
});

test("노드 생성과 삭제를 찾는다", () => {
  const node = h("button", { type: "button" }, ["저장"]);

  assert.deepEqual(diff(null, node), [
    { type: "CREATE", path: [], node },
  ]);
  assert.deepEqual(diff(node, null), [{ type: "REMOVE", path: [] }]);
});

test("노드 타입이 다르면 하위 트리를 교체한다", () => {
  const next = h("span", {}, ["Hello"]);

  assert.deepEqual(diff(h("div", {}, ["Hello"]), next), [
    { type: "REPLACE", path: [], node: next },
  ]);
  assert.deepEqual(diff("Hello", next), [
    { type: "REPLACE", path: [], node: next },
  ]);
});

test("같은 요소의 속성 추가·변경·삭제를 한 명령으로 만든다", () => {
  const oldNode = h("button", { class: "off", title: "설명" }, []);
  const newNode = h("button", { class: "on", disabled: "" }, []);

  assert.deepEqual(diff(oldNode, newNode), [
    {
      type: "UPDATE_PROPS",
      path: [],
      set: { class: "on", disabled: "" },
      remove: ["title"],
    },
  ]);
});

test("같은 타입의 자식과 텍스트를 위치에 따라 재귀 비교한다", () => {
  const oldTree = h("section", {}, [h("p", {}, ["Old"])]);
  const newTree = h("section", {}, [
    h("p", {}, ["New"]),
    h("button", {}, ["추가"]),
  ]);

  assert.deepEqual(diff(oldTree, newTree), [
    { type: "UPDATE_TEXT", path: [0, 0], value: "New" },
    { type: "CREATE", path: [1], node: newTree.children[1] },
  ]);
});

test("key로 삭제·이동·생성과 같은 항목의 변경을 찾는다", () => {
  const oldTree = h("ul", {}, [
    h("li", { key: "a" }, ["A"]),
    h("li", { key: "b" }, ["B"]),
  ]);
  const newTree = h("ul", {}, [
    h("li", { key: "b" }, ["B!"]),
    h("li", { key: "c" }, ["C"]),
  ]);

  assert.deepEqual(diff(oldTree, newTree), [
    { type: "REMOVE", path: [0], key: "a" },
    { type: "MOVE", path: [], key: "b", to: 0 },
    { type: "UPDATE_TEXT", path: [0, 0], value: "B!" },
    { type: "CREATE", path: [1], node: newTree.children[1], key: "c" },
  ]);
});

test("key 목록은 모든 형제의 고유한 key를 요구한다", () => {
  assert.throws(
    () =>
      diff(
        h("ul", {}, [h("li", { key: "a" }), h("li")]),
        h("ul", {}, []),
      ),
    /all have a key/,
  );
  assert.throws(
    () =>
      diff(
        h("ul", {}, []),
        h("ul", {}, [h("li", { key: "a" }), h("li", { key: "a" })]),
      ),
    /Duplicate key: a/,
  );
});

test("비교 중 이전 트리와 새 트리를 변경하지 않는다", () => {
  const oldTree = h("p", { class: "old" }, ["Old"]);
  const newTree = h("p", { class: "new" }, ["New"]);
  const before = structuredClone({ oldTree, newTree });

  diff(oldTree, newTree);

  assert.deepEqual({ oldTree, newTree }, before);
});
