import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, FunctionComponent, useState, useEffect, useMemo } from '../src/mini-react/index.js';

function root() {
  return new JSDOM('<body></body>').window.document.body;
}
const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test('root state survives renders, batches updates and passes props to stateless children', async () => {
  const container = root();
  let renders = 0;
  let initializations = 0;
  function Child({ count, increment }) {
    return h('button', { onClick: increment }, count);
  }
  function App() {
    renders++;
    const [count, setCount] = useState(() => { initializations++; return 0; });
    return h(Child, { count, increment: () => setCount((n) => n + 1) });
  }
  const instance = new FunctionComponent(App, container).mount();
  const button = container.firstChild;
  button.click();
  button.click();
  await flush();
  assert.equal(container.textContent, '2');
  assert.equal(container.firstChild, button);
  assert.equal(renders, 2);
  assert.equal(initializations, 1);
  button.click();
  await flush();
  assert.equal(container.textContent, '3'); // Old event listeners must be removed.
  instance.unmount();
});

test('memo caches dependencies; effects run after DOM updates and clean up', async () => {
  const container = root();
  const calls = [];
  let setCount;
  let calculations = 0;
  function App({ label }) {
    const [count, set] = useState(0);
    setCount = set;
    const squared = useMemo(() => { calculations++; return count * count; }, [count]);
    useEffect(() => {
      calls.push(`effect:${container.textContent}`);
      return () => calls.push(`cleanup:${count}`);
    }, [count]);
    return h('p', {}, `${label}:${squared}`);
  }
  const instance = new FunctionComponent(App, container, { label: 'A' }).mount();
  instance.update({ label: 'B' });
  assert.equal(calculations, 1);
  assert.deepEqual(calls, ['effect:A:0']);
  setCount(2);
  await flush();
  assert.equal(calculations, 2);
  assert.deepEqual(calls, ['effect:A:0', 'cleanup:0', 'effect:B:4']);
  instance.unmount();
  assert.equal(calls.at(-1), 'cleanup:2');
  assert.equal(container.textContent, '');
  setCount(3);
  await flush();
  assert.equal(container.textContent, '');
});

test('effect dependency modes and effect-triggered state updates', async () => {
  const container = root();
  let every = 0;
  let once = 0;
  function App() {
    const [count, setCount] = useState(0);
    useEffect(() => { every++; });
    useEffect(() => { once++; setCount(1); }, []);
    return count;
  }
  const instance = new FunctionComponent(App, container).mount();
  await flush();
  assert.equal(container.textContent, '1');
  assert.equal(every, 2);
  assert.equal(once, 1);
  instance.unmount();
});

test('hooks are rejected outside root render and in child components', () => {
  assert.throws(() => useState(0), /root component/);
  for (const useHook of [() => useState(0), () => useMemo(() => 1, []), () => useEffect(() => {}, [])]) {
    function Child() { useHook(); return h('p', {}, 'invalid'); }
    const instance = new FunctionComponent(() => h(Child), root());
    assert.throws(() => instance.mount(), /root component/);
  }
});

test('conditional hooks are rejected and separate roots have independent state', async () => {
  function Conditional({ enabled }) {
    if (enabled) useState(0);
    return 'ok';
  }
  const invalid = new FunctionComponent(Conditional, root(), { enabled: true }).mount();
  assert.throws(() => invalid.update({ enabled: false }), /Hook count/);
  function Counter() {
    const [count, set] = useState(0);
    return h('button', { onClick: () => set((n) => n + 1) }, count);
  }
  const a = root();
  const b = root();
  new FunctionComponent(Counter, a).mount();
  new FunctionComponent(Counter, b).mount();
  a.firstChild.click();
  await flush();
  assert.equal(a.textContent, '1');
  assert.equal(b.textContent, '0');
});
