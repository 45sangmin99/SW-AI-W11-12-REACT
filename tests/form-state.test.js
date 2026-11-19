import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as runtime from '../src/mini-react/index.js';
import { createPreviewController } from '../src/preview-controller.js';

test('form properties change independently of their HTML attributes', () => {
  const dom = new JSDOM('<input value="민수"><input type="checkbox" checked><select><option selected>A</option><option>B</option></select>');
  try {
    const [input, checkbox] = dom.window.document.querySelectorAll('input');
    const select = dom.window.document.querySelector('select');
    input.value = '지수';
    checkbox.checked = false;
    select.selectedIndex = 1;
    assert.equal(input.getAttribute('value'), '민수');
    assert.equal(input.value, '지수');
    assert.equal(checkbox.hasAttribute('checked'), true);
    assert.equal(checkbox.checked, false);
    assert.equal(select.options[0].hasAttribute('selected'), true);
    assert.equal(select.options[0].selected, false);
    assert.equal(select.options[1].selected, true);
  } finally { dom.window.close(); }
});

test('current limitation: DOM snapshots retain form attributes, not edited value/checked/selected properties', () => {
  const dom = new JSDOM('<div><input value="민수"><input type="checkbox" checked><select><option selected>A</option><option>B</option></select></div>');
  try {
    const document = dom.window.document;
    const original = document.querySelector('div');
    original.children[0].value = '지수';
    original.children[1].checked = false;
    original.children[2].selectedIndex = 1;
    const snapshot = runtime.domToVDOM(original);
    const restored = runtime.createDOM(snapshot, document);
    assert.equal(snapshot.children[0].props.value, '민수');
    assert.equal(restored.children[0].value, '민수');
    assert.equal(restored.children[1].checked, true);
    assert.equal(restored.children[2].selectedIndex, 0);
    // This documents missing support; these are NOT the desired restored values.
    assert.notEqual(restored.children[0].value, original.children[0].value);
    assert.notEqual(restored.children[1].checked, original.children[1].checked);
    assert.notEqual(restored.children[2].selectedIndex, original.children[2].selectedIndex);
  } finally { dom.window.close(); }
});

test('value Patch updates an edited input property while preserving its DOM node', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const { document } = dom.window;
    const before = runtime.parseHTML('<input value="민수">', document);
    document.body.append(runtime.createDOM(before, document));
    const input = document.querySelector('input');
    input.value = '지수'; // Marks the live value as edited (dirty).
    const after = runtime.parseHTML('<input value="영희">', document);
    runtime.patch(document.body, runtime.diff(before, after));
    assert.equal(document.querySelector('input'), input);
    assert.equal(input.getAttribute('value'), '영희');
    assert.equal(input.value, '영희');
  } finally { dom.window.close(); }
});

test('controlled input preserves the cursor while typing and resets its live value from root state', async () => {
  const dom = new JSDOM('<body></body>');
  const { document, Event } = dom.window;
  let instance;
  try {
    function App() {
      const [value, setValue] = runtime.useState('처음');
      return runtime.h('section', {},
        runtime.h('input', { value, onInput: event => setValue(event.target.value) }),
        runtime.h('button', { onClick: () => setValue('') }, '초기화'),
        runtime.h('p', {}, value));
    }
    instance = new runtime.FunctionComponent(App, document.body).mount();
    const input = document.querySelector('input');
    const button = document.querySelector('button');
    const paragraph = document.querySelector('p');
    input.focus();
    input.value = '수정한 검색어';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(input.value, '수정한 검색어');
    assert.equal(input.getAttribute('value'), '수정한 검색어');
    assert.equal(input.selectionStart, 3);
    assert.equal(document.activeElement, input);
    assert.equal(paragraph.textContent, '수정한 검색어');

    button.click();
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('value'), '');
    assert.equal(paragraph.textContent, '');
    assert.equal(document.querySelector('input'), input);
    assert.equal(document.querySelector('button'), button);
    assert.equal(document.querySelector('p'), paragraph);
  } finally { instance?.unmount(); dom.window.close(); }
});

test('controlled range tracks state updates after the user has dragged it', async () => {
  const dom = new JSDOM('<body></body>');
  const { document, Event } = dom.window;
  let setPosition;
  let instance;
  try {
    function App() {
      const [position, set] = runtime.useState(10);
      setPosition = set;
      return runtime.h('input', { type: 'range', min: 0, max: 100, value: position,
        onInput: event => set(event.target.valueAsNumber) });
    }
    instance = new runtime.FunctionComponent(App, document.body).mount();
    const range = document.querySelector('input');
    range.value = '35';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(range.value, '35');

    setPosition(36);
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(range.value, '36');
    assert.equal(range.getAttribute('value'), '36');
    assert.equal(document.querySelector('input'), range);
  } finally { instance?.unmount(); dom.window.close(); }
});

test('textarea value Patch and removal synchronize the live property; nonempty file values are not assigned', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const { document } = dom.window;
    const before = runtime.parseHTML('<textarea value="원본"></textarea>', document);
    document.body.append(runtime.createDOM(before, document));
    const textarea = document.querySelector('textarea');
    textarea.value = '사용자가 수정';
    const after = runtime.parseHTML('<textarea value="갱신"></textarea>', document);
    runtime.patch(document.body, runtime.diff(before, after));
    assert.equal(textarea.value, '갱신');
    assert.equal(textarea.getAttribute('value'), '갱신');
    runtime.patch(document.body, runtime.diff(after, runtime.parseHTML('<textarea></textarea>', document)));
    assert.equal(textarea.value, '');
    assert.equal(textarea.hasAttribute('value'), false);
    assert.equal(document.querySelector('textarea'), textarea);

    const file = runtime.createDOM(runtime.h('input', { type: 'file', value: 'not-a-real-file.txt' }), document);
    assert.equal(file.value, '');
    assert.equal(file.getAttribute('value'), 'not-a-real-file.txt');
  } finally { dom.window.close(); }
});

test('current limitation: History restores VDOM content but does not rewind uncontrolled form properties', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const controller = createPreviewController(dom.window, runtime);
  const source = title => `<h1>${title}</h1><input value="민수"><input type="checkbox" checked><select><option selected>A</option><option>B</option></select>`;
  try {
    assert.equal(controller.apply(source('A')), true);
    const document = dom.window.document;
    const [input, checkbox] = document.querySelectorAll('input');
    const select = document.querySelector('select');
    input.value = '지수'; checkbox.checked = false; select.selectedIndex = 1;
    assert.equal(controller.apply(source('B')), true); // B snapshot taken here.
    input.value = '영희'; checkbox.checked = true; select.selectedIndex = 0;
    assert.equal(controller.apply(source('C')), true);
    assert.equal(controller.navigate(-1), true);
    assert.equal(document.querySelector('h1').textContent, 'B');
    assert.equal(document.querySelector('input'), input);
    // B's edited values were not stored: the latest live properties remain.
    assert.equal(input.value, '영희');
    assert.equal(checkbox.checked, true);
    assert.equal(select.selectedIndex, 0);
  } finally { controller.dispose(); dom.window.close(); }
});
