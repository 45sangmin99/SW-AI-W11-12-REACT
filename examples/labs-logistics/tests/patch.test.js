import assert from "node:assert/strict";
import { test } from "node:test";
import { diff } from "../src/engine/diff.js";
import { patch } from "../src/engine/patch.js";
import { vdomToDom } from "../src/engine/render.js";

function withNodeMethods(node) {
  node.remove = function remove() {
    this.parentNode?.removeChild(this);
  };
  node.replaceWith = function replaceWith(replacement) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.insertBefore(replacement, this);
    parent.removeChild(this);
  };
  return node;
}

function createDocument() {
  return {
    createElement(tagName) {
      return withNodeMethods({
        nodeType: 1,
        tagName,
        attributes: {},
        childNodes: [],
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        appendChild(child) {
          return this.insertBefore(child, null);
        },
        insertBefore(child, reference) {
          child.remove();
          const index = reference === null
            ? this.childNodes.length
            : this.childNodes.indexOf(reference);
          this.childNodes.splice(index, 0, child);
          child.parentNode = this;
          return child;
        },
        removeChild(child) {
          const index = this.childNodes.indexOf(child);
          this.childNodes.splice(index, 1);
          child.parentNode = null;
          return child;
        },
      });
    },
    createTextNode(nodeValue) {
      return withNodeMethods({ nodeType: 3, nodeValue, parentNode: null });
    },
  };
}

function h(type, props = {}, children = []) {
  return { type, props, children };
}

function toVdom(node) {
  if (node.nodeType === 3) return node.nodeValue;
  return {
    type: node.tagName,
    props: node.attributes,
    children: node.childNodes.map(toVdom),
  };
}

test("속성·텍스트를 수정하고 새 자식을 추가하면서 기존 요소를 재사용한다", () => {
  const documentRef = createDocument();
  const oldTree = h("section", { class: "old", title: "설명" }, [
    h("p", {}, ["Old"]),
  ]);
  const newTree = h("section", { class: "new" }, [
    h("p", {}, ["New"]),
    h("button", { type: "button" }, ["추가"]),
  ]);
  const root = vdomToDom(oldTree, documentRef);
  const paragraph = root.childNodes[0];

  const updatedRoot = patch(root, diff(oldTree, newTree), documentRef);

  assert.deepEqual(toVdom(updatedRoot), newTree);
  assert.equal(updatedRoot.childNodes[0], paragraph);
});

test("연속된 자식 삭제를 뒤에서부터 안전하게 적용한다", () => {
  const documentRef = createDocument();
  const oldTree = h("ul", {}, [h("li", {}, ["A"]), h("li", {}, ["B"]), h("li", {}, ["C"])]);
  const newTree = h("ul", {}, [h("li", {}, ["A"])]);
  const root = vdomToDom(oldTree, documentRef);

  assert.deepEqual(toVdom(patch(root, diff(oldTree, newTree), documentRef)), newTree);
});

test("실제 DOM의 들여쓰기 공백을 포함해 Virtual DOM 경로를 찾는다", () => {
  const documentRef = createDocument();
  const oldTree = h("section", {}, ["\n  ", h("p", {}, ["Old"]), "\n"]);
  const newTree = h("section", {}, ["\n  ", h("p", {}, ["New"]), "\n"]);
  const root = documentRef.createElement("section");
  const paragraph = vdomToDom(oldTree.children[1], documentRef);

  root.appendChild(documentRef.createTextNode("\n  "));
  root.appendChild(paragraph);
  root.appendChild(documentRef.createTextNode("\n"));

  patch(root, diff(oldTree, newTree), documentRef);

  assert.equal(paragraph.childNodes[0].nodeValue, "New");
  assert.equal(root.childNodes.length, 3);
});

test("key 목록의 삭제·이동·생성과 내부 변경을 적용한다", () => {
  const documentRef = createDocument();
  const oldTree = h("ul", {}, [
    h("li", { key: "a" }, ["A"]),
    h("li", { key: "b" }, ["B"]),
  ]);
  const newTree = h("ul", {}, [
    h("li", { key: "b" }, ["B!"]),
    h("li", { key: "c" }, ["C"]),
  ]);
  const root = vdomToDom(oldTree, documentRef);
  const reused = root.childNodes[1];

  const updatedRoot = patch(root, diff(oldTree, newTree), documentRef);

  assert.deepEqual(toVdom(updatedRoot), newTree);
  assert.equal(updatedRoot.childNodes[0], reused);
});

test("여러 key 이동 후에도 원하는 순서와 노드 정체성을 유지한다", () => {
  const documentRef = createDocument();
  const oldTree = h("ul", {}, [
    h("li", { key: "a" }, ["A"]),
    h("li", { key: "b" }, ["B"]),
    h("li", { key: "c" }, ["C"]),
  ]);
  const newTree = h("ul", {}, [
    h("li", { key: "c" }, ["C"]),
    h("li", { key: "a" }, ["A"]),
    h("li", { key: "b" }, ["B"]),
  ]);
  const root = vdomToDom(oldTree, documentRef);
  const nodes = Object.fromEntries(root.childNodes.map((node) => [node.getAttribute("key"), node]));

  const updatedRoot = patch(root, diff(oldTree, newTree), documentRef);

  assert.deepEqual(toVdom(updatedRoot), newTree);
  assert.deepEqual(updatedRoot.childNodes, [nodes.c, nodes.a, nodes.b]);
});

test("key 재정렬 중 최종 인덱스가 같은 항목도 올바른 위치와 내용을 유지한다", () => {
  const documentRef = createDocument();
  const item = (key, label = key) => h("li", { key }, [label]);
  const oldTree = h("ul", {}, [item("a"), item("b"), item("c"), item("d")]);
  const newTree = h("ul", {}, [item("d"), item("b", "B!"), item("c"), item("a")]);
  const root = vdomToDom(oldTree, documentRef);
  const [a, b, c, d] = root.childNodes;

  const updated = patch(root, diff(oldTree, newTree), documentRef);

  assert.deepEqual(toVdom(updated), newTree);
  [d, b, c, a].forEach((node, index) => assert.equal(updated.childNodes[index], node));
});

test("공백 추가·삭제와 key 이동을 함께 적용하고 되돌린다", () => {
  const documentRef = createDocument();
  const a = h("span", { key: "a" }, ["Hello"]);
  const b = h("span", { key: "b" }, ["World"]);
  const before = h("div", {}, [a, " ", b]);
  const after = h("div", {}, ["\n", b, a, " "]);
  const root = vdomToDom(before, documentRef);
  const [first, , last] = root.childNodes;

  patch(root, diff(before, after), documentRef);
  assert.deepEqual(toVdom(root), after);
  assert.equal(root.childNodes[1], last);
  assert.equal(root.childNodes[2], first);

  patch(root, diff(after, before), documentRef);
  assert.deepEqual(toVdom(root), before);
  assert.equal(root.childNodes[0], first);
  assert.equal(root.childNodes[2], last);
});

test("루트 교체·삭제·생성 결과를 반환한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const oldTree = h("p", {}, ["Old"]);
  const newTree = h("h1", {}, ["New"]);
  const root = vdomToDom(oldTree, documentRef);
  container.appendChild(root);

  const replaced = patch(root, diff(oldTree, newTree), documentRef);
  assert.deepEqual(toVdom(replaced), newTree);
  assert.equal(container.childNodes[0], replaced);

  assert.equal(patch(replaced, diff(newTree, null), documentRef), null);
  assert.deepEqual(toVdom(patch(null, diff(null, oldTree), documentRef)), oldTree);
});

test("이벤트 핸들러 prop을 교체하고 제거한다", () => {
  const documentRef = createDocument();
  const first = () => "first";
  const second = () => "second";
  const oldTree = h("button", { onClick: first }, ["증가"]);
  const nextTree = h("button", { onClick: second }, ["증가"]);
  const finalTree = h("button", {}, ["증가"]);
  const root = vdomToDom(oldTree, documentRef);

  patch(root, diff(oldTree, nextTree), documentRef);
  assert.equal(root.onclick, second);

  patch(root, diff(nextTree, finalTree), documentRef);
  assert.equal(root.onclick, null);
});
