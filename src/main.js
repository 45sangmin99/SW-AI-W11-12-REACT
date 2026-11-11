import { domContainerToVdom } from "./vdom.js";
import { FunctionComponent, useEffect, useMemo, useState } from "./component.js";
import { diff } from "./diff.js";
import { createHistory } from "./history.js";
import { patch } from "./patch.js";
import { summarizeComponentUpdate, summarizePatches } from "./patch-summary.js";
import { vdomToDom } from "./render.js";
import { filterTodos, syncTodoTitle, toggleTodo } from "./todos.js";

export const phase = 11;

const actualOutput = document.querySelector("#actual-output");
const renderOutput = document.querySelector("#render-output");
const output = document.querySelector("#vdom-output");
const diffOutput = document.querySelector("#diff-output");
const backButton = document.querySelector("#back-button");
const patchButton = document.querySelector("#patch-button");
const forwardButton = document.querySelector("#forward-button");
const historyPosition = document.querySelector("#history-position");
const patchSummary = document.querySelector("#patch-summary");
let currentVdom = domContainerToVdom(actualOutput);
const history = createHistory(currentVdom);

function renderTest(vdom) {
  renderOutput.replaceChildren(
    ...(vdom?.children ?? []).map((child) => vdomToDom(child, document)),
  );
}

function updateHistoryControls() {
  backButton.disabled = !history.canBack;
  forwardButton.disabled = !history.canForward;
  historyPosition.textContent = `저장 상태 ${history.position} / ${history.length}`;
}

function applyVdom(nextVdom) {
  const patches = diff(currentVdom, nextVdom);
  patch(actualOutput, patches, document);

  currentVdom = nextVdom;
  output.textContent = JSON.stringify(currentVdom, null, 2);
  diffOutput.textContent = JSON.stringify(patches, null, 2);
  return patches;
}

renderTest(currentVdom);
output.textContent = JSON.stringify(currentVdom, null, 2);
diffOutput.textContent = "[]";
updateHistoryControls();
document.querySelector("#app-status").textContent =
  "두 실습 준비 완료";

patchButton.addEventListener("click", () => {
  const nextVdom = domContainerToVdom(renderOutput);
  const patches = applyVdom(nextVdom);

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

function MemoStatus({ calculations }) {
  return {
    type: "p",
    props: { class: "memo-status", "data-child": "memo-status" },
    children: [`useMemo 필터 계산 ${calculations}회`],
  };
}

function TodoItem({ todo, onToggle }) {
  return {
    type: "li",
    props: { key: todo.id, class: todo.completed ? "todo-item is-completed" : "todo-item" },
    children: [
      { type: "span", props: {}, children: [todo.title] },
      {
        type: "button",
        props: { type: "button", onClick: () => onToggle(todo.id) },
        children: [todo.completed ? "진행 중으로 변경" : "완료로 변경"],
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

function TodoApp() {
  const [todos, setTodos] = useState(initialTodos);
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const visibleTodos = useMemo(() => {
    memoRuns += 1;
    return filterTodos(todos, filter);
  }, [todos, filter]);
  useEffect(() => {
    effectOutput.textContent =
      `useEffect: 문서 제목을 할 일 ${todos.length}개와 동기화했습니다.`;
    return syncTodoTitle(document, todos.length);
  }, [todos.length]);

  const update = (message, stateName, ...actions) => {
    const renders = [];
    for (const action of actions) {
      const previousPatches = todoComponent.lastPatches;
      action();
      if (todoComponent.lastPatches !== previousPatches) {
        renders.push(todoComponent.lastPatches);
      }
    }
    componentDiffOutput.textContent = JSON.stringify(
      renders,
      (_name, value) => typeof value === "function" ? "[Function]" : value,
      2,
    );
    componentSummary.textContent = summarizeComponentUpdate(
      message, stateName, renders.flat(), renders.length,
    );
    document.querySelector("#app-status").textContent =
      `실습 2: ${message}`;
  };

  return {
    type: "section",
    props: { class: "component-card todo-app", "data-component": "TodoApp" },
    children: [
      { type: "h3", props: {}, children: ["할 일 관리"] },
      TodoForm({
        draft,
        onDraftChange: (event) => update(
          "입력값 변경",
          "draft",
          () => setDraft(event.target.value),
        ),
        onSubmit: (event) => {
          event.preventDefault();
          const title = draft.trim();
          if (!title) {
            document.querySelector("#app-status").textContent = "실습 2: 할 일을 입력하세요.";
            return;
          }
          update(
            `‘${title}’ 할 일 추가`,
            "draft·todos",
            () => setDraft(""),
            () => setTodos([...todos, { id: `todo-${nextTodoId++}`, title, completed: false }]),
          );
        },
      }),
      TodoFilter({
        filter,
        onChange: (nextFilter) => update(
          "필터 변경",
          "filter",
          () => setFilter(nextFilter),
        ),
      }),
      TodoSummary({ todos }),
      MemoStatus({ calculations: memoRuns }),
      TodoList({
        todos: visibleTodos,
        onToggle: (id) => update(
          "완료 상태 변경",
          "todos",
          () => setTodos(toggleTodo(todos, id)),
        ),
      }),
    ],
  };
}

const componentOutput = document.querySelector("#component-output");
const componentDiffOutput = document.querySelector("#component-diff-output");
const componentSummary = document.querySelector("#component-summary");
const effectOutput = document.querySelector("#effect-output");
const todoComponent = new FunctionComponent(
  TodoApp,
  {},
  componentOutput,
  document,
);

todoComponent.mount();
componentDiffOutput.textContent = "[]";
