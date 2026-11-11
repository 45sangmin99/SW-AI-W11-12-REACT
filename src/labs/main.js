import { domContainerToVdom } from "../engine/vdom.js";
import { FunctionComponent, useEffect, useMemo, useState } from "../engine/component.js";
import { diff } from "../engine/diff.js";
import { createHistory } from "./history.js";
import { patch } from "../engine/patch.js";
import { summarizePatches } from "./patch-summary.js";
import { vdomToDom } from "../engine/render.js";
import { filterTodos, syncTodoTitle, toggleTodo } from "./todos.js";

export const phase = 11;

const actualOutput = document.querySelector("#actual-output");
const renderOutput = document.querySelector("#render-output");
const output = document.querySelector("#vdom-output");
const previousOutput = document.querySelector("#previous-vdom-output");
const inspection = document.querySelector("#dom-inspection");
const example = document.querySelector("#dom-example");
const exampleHelp = document.querySelector("#dom-example-help");
const initialHtml = actualOutput.innerHTML;
const sampleTags = new Set("article aside blockquote br button code dd div dl dt em h1 h2 h3 h4 h5 h6 hr input label li ol p pre section small span strong ul".split(" "));
const sampleAttributes = new Set("class id key title type disabled checked value for role".split(" "));
const diffOutput = document.querySelector("#diff-output");
const backButton = document.querySelector("#back-button");
const patchButton = document.querySelector("#patch-button");
const forwardButton = document.querySelector("#forward-button");
const historyPosition = document.querySelector("#history-position");
const patchSummary = document.querySelector("#patch-summary");
let currentVdom = domContainerToVdom(actualOutput);
const history = createHistory(currentVdom);

function renderTest(vdom) {
  const container = document.createElement("template");
  container.content.append(...vdom.children.map((child) => vdomToDom(child, document)));
  renderOutput.value = container.innerHTML;
}

function readTestHtml() {
  const template = document.createElement("template");
  template.innerHTML = renderOutput.value;
  for (const element of template.content.querySelectorAll("*")) {
    if (!sampleTags.has(element.localName)) {
      throw new Error(`실습에서 사용할 수 없는 태그입니다: <${element.localName}>`);
    }

    for (const { name } of element.attributes) {
      if (!sampleAttributes.has(name) && !/^(aria|data)-/.test(name)) {
        throw new Error(`실습에서 사용할 수 없는 속성입니다: ${name}`);
      }
    }
  }

  const container = document.createElement("div");
  container.append(template.content);
  return domContainerToVdom(container);
}

function showInspection(before, after) {
  if (before.length > 1 || after.length > 1) {
    inspection.textContent = "data-inspect를 한 요소에만 붙여 비교하세요.";
    return;
  }

  const [previousNode] = before;
  const [nextNode] = after;
  if (!previousNode && !nextNode) {
    inspection.textContent = "비교할 요소 하나에 data-inspect를 붙이세요.";
    return;
  }

  const tag = (node) => node ? `<${node.localName}>` : "없음";
  const disabled = nextNode && "disabled" in nextNode ? ` · after.disabled = ${nextNode.disabled}` : "";
  inspection.textContent = `[data-inspect] ${tag(previousNode)} → ${tag(nextNode)} · before === after → ${previousNode === nextNode}${disabled}`;
}

function updateHistoryControls() {
  backButton.disabled = !history.canBack;
  forwardButton.disabled = !history.canForward;
  historyPosition.textContent = `저장 상태 ${history.position} / ${history.length}`;
}

function applyVdom(nextVdom, patches = diff(currentVdom, nextVdom)) {
  const before = actualOutput.querySelectorAll("[data-inspect]");
  patch(actualOutput, patches, document);
  const after = actualOutput.querySelectorAll("[data-inspect]");

  previousOutput.textContent = JSON.stringify(currentVdom, null, 2);
  currentVdom = nextVdom;
  output.textContent = JSON.stringify(currentVdom, null, 2);
  diffOutput.textContent = JSON.stringify(patches, null, 2);
  showInspection(before, after);
  return patches;
}

renderTest(currentVdom);
previousOutput.textContent = "아직 비교하지 않았습니다.";
output.textContent = JSON.stringify(currentVdom, null, 2);
diffOutput.textContent = "[]";
updateHistoryControls();
document.querySelector("#app-status").textContent =
  "두 실습 준비 완료";

function sampleHtml(edit) {
  const template = document.createElement("template");
  template.innerHTML = initialHtml;
  edit(template.content.querySelector("[data-inspect]"));
  return template.innerHTML;
}

const examples = {
  initial: [initialHtml, "초기 HTML을 불러왔습니다. Patch를 적용하면 실제 영역에 반영됩니다."],
  props: [sampleHtml((button) => button.removeAttribute("disabled")), "disabled를 지우면 기존 버튼이 유지될까요?"],
  text: [sampleHtml((button) => { button.textContent = "Patch 완료"; }), "글자만 바꾸면 기존 버튼이 유지될까요?"],
  replace: [
    sampleHtml((button) => {
      const span = document.createElement("span");
      span.setAttribute("data-inspect", "");
      span.textContent = button.textContent;
      button.replaceWith(span);
    }),
    "button을 span으로 바꾸면 기존 DOM 객체가 유지될까요?",
  ],
};

example.addEventListener("change", () => {
  const selected = examples[example.value];
  if (selected) [renderOutput.value, exampleHelp.textContent] = selected;
  example.value = "";
});

patchButton.addEventListener("click", () => {
  let nextVdom;
  let changes;
  try {
    nextVdom = readTestHtml();
    changes = diff(currentVdom, nextVdom);
  } catch (error) {
    patchSummary.textContent = `입력을 적용할 수 없습니다. ${error.message}`;
    return;
  }
  const patches = applyVdom(nextVdom, changes);


  if (patches.length) {
    history.push(nextVdom);
    patchSummary.textContent = `${summarizePatches(patches)} · 새 상태를 저장했습니다.`;
  } else {
    patchSummary.textContent = summarizePatches(patches);
  }
  updateHistoryControls();
  document.querySelector("#app-status").textContent =
    `실습 1: ${patches.length}개 변경 적용 완료`;
});

backButton.addEventListener("click", () => {
  const snapshot = history.back();
  const patches = applyVdom(snapshot);
  renderTest(snapshot);
  patchSummary.textContent = `이전 상태로 이동했습니다. ${summarizePatches(patches)}`;
  updateHistoryControls();
  document.querySelector("#app-status").textContent =
    `실습 1: 이전 상태로 이동 완료`;
});

forwardButton.addEventListener("click", () => {
  const snapshot = history.forward();
  const patches = applyVdom(snapshot);
  renderTest(snapshot);
  patchSummary.textContent = `다음 상태로 이동했습니다. ${summarizePatches(patches)}`;
  updateHistoryControls();
  document.querySelector("#app-status").textContent =
    `실습 1: 다음 상태로 이동 완료`;
});

function TodoForm({ draft, onDraftChange, onSubmit }) {
  return {
    type: "form",
    props: { class: "todo-form", onSubmit },
    children: [
      { type: "label", props: { for: "todo-draft" }, children: ["새 할 일"] },
      {
        type: "div",
        props: { class: "todo-entry" },
        children: [
          {
            type: "input",
            props: {
              id: "todo-draft",
              type: "text",
              value: draft,
              placeholder: "예: Diff 결과 확인",
              autocomplete: "off",
              onInput: onDraftChange,
            },
            children: [],
          },
          { type: "button", props: { type: "submit" }, children: ["할 일 추가"] },
        ],
      },
    ],
  };
}

function TodoFilter({ filter, onChange }) {
  const filters = [
    ["all", "전체"],
    ["active", "진행 중"],
    ["completed", "완료"],
  ];
  return {
    type: "div",
    props: { class: "todo-filters", "aria-label": "할 일 필터" },
    children: filters.map(([value, label]) => ({
      type: "button",
      props: {
        type: "button",
        class: filter === value ? "is-active" : "",
        "aria-pressed": filter === value,
        onClick: () => onChange(value),
      },
      children: [label],
    })),
  };
}

function TodoSummary({ todos }) {
  const completed = todos.filter((todo) => todo.completed).length;
  return {
    type: "p",
    props: { class: "todo-summary", "data-child": "summary" },
    children: [`전체 ${todos.length}개 · 완료 ${completed}개 · 진행 중 ${todos.length - completed}개`],
  };
}



function TodoItem({ todo, onToggle }) {
  return {
    type: "li",
    props: { key: todo.id, class: todo.completed ? "todo-item is-completed" : "todo-item" },
    children: [
      { type: "span", props: { title: todo.title }, children: [todo.title] },
      {
        type: "button",
        props: {
          type: "button",
          "aria-label": todo.completed ? `${todo.title} 완료 취소` : `${todo.title} 완료`,
          onClick: () => onToggle(todo.id),
        },
        children: [todo.completed ? "완료 취소" : "완료"],
      },
    ],
  };
}

function TodoList({ todos, onToggle }) {
  if (todos.length === 0) {
    return { type: "p", props: { class: "empty-state" }, children: ["이 조건에 맞는 할 일이 없습니다."] };
  }
  return {
    type: "ul",
    props: { class: "todo-list", "data-child": "list" },
    children: todos.map((todo) => TodoItem({ todo, onToggle })),
  };
}

const initialTodos = [
  { id: "vdom", title: "Virtual DOM 흐름 확인", completed: true },
  { id: "component", title: "함수형 컴포넌트 연결", completed: false },
];
let nextTodoId = 1;
let memoRuns = 0;
let effectRuns = 0;
let todoView;

function describeStateChange(before, after, todoId) {
  const changes = [];
  if (before.draft !== after.draft) {
    changes.push(`draft: ${JSON.stringify(before.draft)} → ${JSON.stringify(after.draft)}`);
  }
  if (before.filter !== after.filter) {
    changes.push(`filter: ${before.filter} → ${after.filter}`);
  }
  if (before.todos.length !== after.todos.length) {
    changes.push(`todos.length: ${before.todos.length} → ${after.todos.length}`);
  }
  if (todoId !== undefined) {
    const previous = before.todos.find(({ id }) => id === todoId);
    const current = after.todos.find(({ id }) => id === todoId);
    changes.push(`${current.title} · completed: ${previous.completed} → ${current.completed}`);
  }
  return changes.join(" · ") || "상태 변경 없음";
}

function updateTodos(message, actions, todoId) {
  const before = todoView;
  const previousMemoRuns = memoRuns;
  const previousEffectRuns = effectRuns;
  const renders = [];
  for (const action of actions) {
    const previousPatches = todoComponent.lastPatches;
    action();
    if (todoComponent.lastPatches !== previousPatches) {
      renders.push(todoComponent.lastPatches);
    }
  }

  const after = todoView;
  const previousCompleted = before.todos.filter(({ completed }) => completed).length;
  const currentCompleted = after.todos.filter(({ completed }) => completed).length;
  const outcomes = [];
  if (before.visibleTodos.length !== after.visibleTodos.length) {
    outcomes.push(`표시 항목 ${before.visibleTodos.length} → ${after.visibleTodos.length}`);
  }
  if (previousCompleted !== currentCompleted) {
    outcomes.push(`완료 건수 ${previousCompleted} → ${currentCompleted}`);
  }
  const patches = renders.flat();
  outcomes.push(summarizePatches(patches));

  componentSummary.textContent = message;
  componentState.textContent = describeStateChange(before, after, todoId);
  componentRender.textContent = `update() → TodoApp 재실행 ${renders.length}회`;
  componentMemo.textContent = memoRuns > previousMemoRuns
    ? `useMemo · 필터 결과 재계산 ${memoRuns - previousMemoRuns}회`
    : renders.length ? "useMemo · 기존 필터 결과 재사용" : "useMemo · 렌더링 생략";
  componentPatch.textContent = outcomes.join(" · ");
  effectOutput.textContent = effectRuns > previousEffectRuns
    ? `useEffect · 실행 ${effectRuns - previousEffectRuns}회 · 문서 제목: ${document.title}`
    : renders.length ? "useEffect · 실행 생략 · 할 일 개수가 같습니다." : "useEffect · 렌더링 생략";
  componentDiffOutput.textContent = JSON.stringify(
    renders,
    (_name, value) => typeof value === "function" ? "[Function]" : value,
    2,
  );
  document.querySelector("#app-status").textContent = `실습 2: ${message}`;
}

function TodoApp() {
  const [todos, setTodos] = useState(initialTodos);
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const visibleTodos = useMemo(() => {
    memoRuns += 1;
    return filterTodos(todos, filter);
  }, [todos, filter]);
  todoView = { todos, filter, draft, visibleTodos };
  useEffect(() => {
    effectRuns += 1;
    return syncTodoTitle(document, todos.length);
  }, [todos.length]);

  return {
    type: "section",
    props: { class: "component-card todo-app", "data-component": "TodoApp" },
    children: [
      { type: "h3", props: {}, children: ["할 일 앱"] },
      TodoForm({
        draft,
        onDraftChange: (event) => updateTodos("입력값 변경", [
          () => setDraft(event.target.value),
        ]),
        onSubmit: (event) => {
          event.preventDefault();
          const title = draft.trim();
          if (!title) {
            document.querySelector("#app-status").textContent = "실습 2: 할 일을 입력하세요.";
            return;
          }
          const todo = { id: `todo-${nextTodoId++}`, title, completed: false };
          updateTodos(`‘${title}’ 할 일 추가`, [
            () => setDraft(""),
            () => setTodos([...todos, todo]),
          ]);
        },
      }),
      TodoFilter({
        filter,
        onChange: (nextFilter) => updateTodos("필터 변경", [() => setFilter(nextFilter)]),
      }),
      TodoSummary({ todos }),
      TodoList({
        todos: visibleTodos,
        onToggle: (id) => {
          const todo = todos.find((item) => item.id === id);
          const action = todo.completed ? "진행 중으로 변경" : "완료";
          updateTodos(`‘${todo.title}’ ${action}`, [
            () => setTodos(toggleTodo(todos, id)),
          ], id);
        },
      }),
    ],
  };
}

const componentOutput = document.querySelector("#component-output");
const componentDiffOutput = document.querySelector("#component-diff-output");
const componentSummary = document.querySelector("#component-summary");
const componentState = document.querySelector("#component-state");
const componentRender = document.querySelector("#component-render");
const componentMemo = document.querySelector("#component-memo");
const componentPatch = document.querySelector("#component-patch");
const effectOutput = document.querySelector("#effect-output");
const todoComponent = new FunctionComponent(
  TodoApp,
  {},
  componentOutput,
  document,
);

todoComponent.mount();
componentDiffOutput.textContent = "[]";
