import assert from "node:assert/strict";
import { test } from "node:test";
import { vdomToDom } from "../src/engine/render.js";

function createDocument() {
  return {
    createElement(tagName) {
      return {
        nodeType: 1,
        tagName,
        attributes: {},
        childNodes: [],
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        appendChild(child) {
          this.childNodes.push(child);
        },
      };
    },
    createTextNode(nodeValue) {
      return { nodeType: 3, nodeValue };
    },
  };
}

function toPlainNode(node) {
  if (node.nodeType === 3) {
    return node;
  }

  return {
    nodeType: node.nodeType,
    tagName: node.tagName,
    attributes: node.attributes,
    childNodes: node.childNodes.map(toPlainNode),
  };
}

test("문자열 Virtual DOM을 Text Node로 렌더링한다", () => {
  assert.deepEqual(vdomToDom(" Hello ", createDocument()), {
    nodeType: 3,
    nodeValue: " Hello ",
  });
});

test("요소의 속성과 중첩된 자식을 재귀적으로 렌더링한다", () => {
  const vnode = {
    type: "button",
    props: { class: "primary", disabled: "" },
    children: [
      "저장 ",
      { type: "strong", props: {}, children: ["완료"] },
    ],
  };

  assert.deepEqual(toPlainNode(vdomToDom(vnode, createDocument())), {
    nodeType: 1,
    tagName: "button",
    attributes: { class: "primary", disabled: "" },
    childNodes: [
      { nodeType: 3, nodeValue: "저장 " },
      {
        nodeType: 1,
        tagName: "strong",
        attributes: {},
        childNodes: [{ nodeType: 3, nodeValue: "완료" }],
      },
    ],
  });
});

test("렌더링 중 Virtual DOM을 변경하지 않는다", () => {
  const vnode = {
    type: "p",
    props: { title: "greeting" },
    children: ["Hello"],
  };
  const before = structuredClone(vnode);

  vdomToDom(vnode, createDocument());

  assert.deepEqual(vnode, before);
});

test("함수형 이벤트 prop을 DOM 이벤트 핸들러로 연결한다", () => {
  const onClick = () => {};
  const button = vdomToDom({
    type: "button",
    props: { onClick },
    children: ["증가"],
  }, createDocument());

  assert.equal(button.onclick, onClick);
  assert.deepEqual(button.attributes, {});
});
