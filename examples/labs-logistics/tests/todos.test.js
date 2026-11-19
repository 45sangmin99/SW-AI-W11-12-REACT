import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTodos, syncTodoTitle, toggleTodo } from "../src/labs/todos.js";

const todos = [
  { id: "a", title: "A", completed: false },
  { id: "b", title: "B", completed: true },
];

test("필터에 맞는 할 일만 반환한다", () => {
  assert.deepEqual(filterTodos(todos, "all"), todos);
  assert.deepEqual(filterTodos(todos, "active"), [todos[0]]);
  assert.deepEqual(filterTodos(todos, "completed"), [todos[1]]);
});

test("선택한 할 일의 완료 상태만 새 배열에서 변경한다", () => {
  const updated = toggleTodo(todos, "a");

  assert.notEqual(updated, todos);
  assert.deepEqual(updated, [
    { id: "a", title: "A", completed: true },
    todos[1],
  ]);
  assert.equal(updated[1], todos[1]);
  assert.equal(todos[0].completed, false);
});

test("문서 제목에 할 일 개수를 표시하고 cleanup으로 복구한다", () => {
  const documentRef = { title: "Mini React" };

  const cleanup = syncTodoTitle(documentRef, 2);
  assert.equal(documentRef.title, "할 일 2개 · Mini React");

  cleanup();
  assert.equal(documentRef.title, "Mini React");
});
