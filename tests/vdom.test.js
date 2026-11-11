import assert from "node:assert/strict";
import { test } from "node:test";
import { domContainerToVdom, domToVdom } from "../src/engine/vdom.js";

function element(tagName, attributes = [], childNodes = []) {
  return {
    nodeType: 1,
    tagName,
    attributes: attributes.map(([name, value]) => ({ name, value })),
    childNodes,
  };
}

function text(nodeValue) {
  return { nodeType: 3, nodeValue };
}

test("요소의 태그와 속성을 변환한다", () => {
  const node = element("BUTTON", [
    ["id", "save"],
    ["class", "primary"],
    ["disabled", ""],
  ]);

  assert.deepEqual(domToVdom(node), {
    type: "button",
    props: { id: "save", class: "primary", disabled: "" },
    children: [],
  });
});

test("의미 있는 텍스트의 공백을 보존한다", () => {
  assert.equal(domToVdom(text(" Hello ")), " Hello ");
});

test("공백 텍스트를 보존하고 지원하지 않는 노드는 제외한다", () => {
  assert.equal(domToVdom(text("\n  ")), "\n  ");
  assert.equal(domToVdom(text(" ")), " ");
  assert.equal(domToVdom({ nodeType: 8, nodeValue: "comment" }), null);
  assert.equal(domToVdom(null), null);
});

test("중첩된 자식을 순서대로 재귀 변환한다", () => {
  const node = element("UL", [], [
    text("\n  "),
    element("LI", [["data-id", "a"]], [text("A")]),
    element("LI", [["data-id", "b"]], [text("B")]),
    { nodeType: 8, nodeValue: "ignored" },
  ]);

  assert.deepEqual(domToVdom(node), {
    type: "ul",
    props: {},
    children: [
      "\n  ",
      { type: "li", props: { "data-id": "a" }, children: ["A"] },
      { type: "li", props: { "data-id": "b" }, children: ["B"] },
    ],
  });
});

test("컨테이너의 모든 최상위 노드를 하나의 Virtual DOM 루트에 포함한다", () => {
  const container = element("DIV", [["id", "render-output"]], [
    element("ARTICLE", [], [text("기존 내용")]),
    text("새 텍스트"),
    element("P", [], [text("새 문단")]),
  ]);

  assert.deepEqual(domContainerToVdom(container), {
    type: "div",
    props: {},
    children: [
      { type: "article", props: {}, children: ["기존 내용"] },
      "새 텍스트",
      { type: "p", props: {}, children: ["새 문단"] },
    ],
  });
});

test("변환 중 원본 노드를 변경하지 않는다", () => {
  const node = element("P", [["title", "greeting"]], [text("Hello")]);
  const before = structuredClone(node);

  domToVdom(node);

  assert.deepEqual(node, before);
});
