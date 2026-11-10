import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistory } from "../src/history.js";

function state(value) {
  return { type: "p", props: {}, children: [value] };
}

test("초기 스냅샷과 이동 가능 상태를 제공한다", () => {
  const initial = state("A");
  const history = createHistory(initial);

  initial.children[0] = "changed";

  assert.deepEqual(history.current, state("A"));
  assert.equal(history.position, 1);
  assert.equal(history.length, 1);
  assert.equal(history.canBack, false);
  assert.equal(history.canForward, false);
});

test("스냅샷을 추가하고 뒤로가기·앞으로가기를 수행한다", () => {
  const history = createHistory(state("A"));
  history.push(state("B"));
  history.push(state("C"));

  assert.deepEqual(history.back(), state("B"));
  assert.equal(history.canBack, true);
  assert.equal(history.canForward, true);
  assert.deepEqual(history.back(), state("A"));
  assert.deepEqual(history.back(), state("A"));
  assert.equal(history.canBack, false);
  assert.deepEqual(history.forward(), state("B"));
  assert.deepEqual(history.forward(), state("C"));
  assert.deepEqual(history.forward(), state("C"));
  assert.equal(history.canForward, false);
});

test("뒤로간 뒤 새 상태를 추가하면 앞으로가기 이력을 제거한다", () => {
  const history = createHistory(state("A"));
  history.push(state("B"));
  history.push(state("C"));
  history.back();

  history.push(state("D"));

  assert.deepEqual(history.current, state("D"));
  assert.equal(history.length, 3);
  assert.equal(history.position, 3);
  assert.equal(history.canForward, false);
  assert.deepEqual(history.back(), state("B"));
});

test("반환한 스냅샷과 null 상태는 내부 이력을 변경하지 않는다", () => {
  const history = createHistory(null);
  history.push(state("A"));
  const snapshot = history.current;

  snapshot.children[0] = "changed";

  assert.deepEqual(history.current, state("A"));
  assert.equal(history.back(), null);
});
