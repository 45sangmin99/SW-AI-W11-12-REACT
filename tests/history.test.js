import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as runtime from '../src/mini-react/index.js';
import { createPreviewController } from '../src/preview-controller.js';
import { cloneData, historyShortcut } from '../src/history.js';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function setup() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const intervals = new Map();
  let nextId = 0;
  dom.window.setInterval = fn => { const id = ++nextId; intervals.set(id, fn); return id; };
  dom.window.clearInterval = id => intervals.delete(id);
  const controller = createPreviewController(dom.window, runtime);
  return { window: dom.window, document: dom.window.document, controller, intervals,
    close() { controller.dispose(); dom.window.close(); } };
}
const counter = label => `<h1>${label}</h1><div id="root"></div><script type="module">
import {h, FunctionComponent, useState, useEffect} from 'mini-react';
function App() {
  const [state,set] = useState({count:0});
  useEffect(() => { const timer=setInterval(()=>set(previous=>({count:previous.count+1})),1000); return ()=>clearInterval(timer); },[]);
  return h('button',{onClick:()=>set(previous=>({count:previous.count+1}))},state.count);
}
new FunctionComponent(App,document.getElementById('root')).mount();
</script>`;

test('VDOM history restores head/body through Patch, keeps unchanged nodes and respects bounds', () => {
  const h = setup();
  try {
    assert.equal(h.controller.navigate(-1), false);
    for (const text of ['A', 'B', 'C']) assert.equal(h.controller.apply(`<title>${text}</title><h1>${text}</h1><p>keep</p>`), true);
    const p = h.document.querySelector('p');
    assert.equal(h.controller.getHistory().length, 3);
    assert.equal(h.controller.navigate(-1), true);
    assert.equal(h.document.title, 'B');
    assert.equal(h.document.querySelector('h1').textContent, 'B');
    assert.equal(h.document.querySelector('p'), p);
    assert.equal(h.controller.navigate(-1), true);
    assert.equal(h.controller.navigate(-1), false);
    assert.equal(h.controller.navigate(1), true);
    assert.equal(h.document.title, 'B');
    assert.equal(h.controller.getHistory().length, 3);
  } finally { h.close(); }
});

test('unchanged and failed apply do not add history; new branch drops forward snapshots', () => {
  const h = setup();
  try {
    h.controller.apply('<h1>A</h1>');
    h.controller.apply('<h1>A</h1>');
    assert.equal(h.controller.getHistory().length, 1);
    h.controller.apply('<h1>B</h1>');
    h.controller.apply('<h1>C</h1>');
    assert.equal(h.controller.apply('<script>const x = ;</script>'), false);
    assert.equal(h.controller.getHistory().length, 3);
    h.controller.navigate(-1);
    h.controller.apply('<h1>D</h1>');
    assert.deepEqual(h.controller.getHistory(), { index: 2, length: 3, canBack: true, canForward: false });
    assert.equal(h.controller.navigate(1), false);
    h.controller.navigate(-1);
    assert.equal(h.document.querySelector('h1').textContent, 'B');
  } finally { h.close(); }
});

test('restored component state, event closures, VDOM and Effect timers remain consistent', async () => {
  const h = setup();
  try {
    h.controller.apply(counter('A'));
    const button = h.document.querySelector('button');
    button.click(); button.click(); await flush();
    assert.equal(button.textContent, '2');
    h.controller.apply(counter('B'));
    button.click(); await flush();
    assert.equal(button.textContent, '3');
    assert.equal(h.intervals.size, 1);
    h.controller.navigate(-1);
    assert.equal(h.document.querySelector('h1').textContent, 'A');
    assert.equal(button.textContent, '0');
    assert.equal(h.document.querySelector('button'), button);
    assert.equal(h.intervals.size, 1);
    button.click(); await flush();
    assert.equal(button.textContent, '1');
    h.controller.navigate(1);
    assert.equal(button.textContent, '2');
    for (const callback of [...h.intervals.values()]) callback();
    await flush();
    assert.equal(button.textContent, '3');
    assert.equal(h.intervals.size, 1);
    h.controller.navigate(-1);
    assert.equal(button.textContent, '0');
  } finally { h.close(); }
  assert.equal(h.intervals.size, 0);
});

test('history can remove and restore a root added by a later source without reusing dead cleanup', async () => {
  const h = setup();
  try {
    h.controller.apply('<h1>A</h1>');
    h.controller.apply(counter('B'));
    h.controller.navigate(-1);
    assert.equal(h.document.querySelector('#root'), null);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.controller.navigate(1), true);
    assert.equal(h.document.querySelector('button').textContent, '0');
    h.document.querySelector('button').click(); await flush();
    assert.equal(h.document.querySelector('button').textContent, '1');
    assert.equal(h.intervals.size, 1);
  } finally { h.close(); }
});

test('snapshot data is copied, and shortcut handling preserves editable native undo', () => {
  const original = { list: [{ value: 1 }], map: new Map([['x', { value: 2 }]]) };
  const snapshot = cloneData(original);
  original.list[0].value = 8;
  original.map.get('x').value = 9;
  assert.equal(snapshot.list[0].value, 1);
  assert.equal(snapshot.map.get('x').value, 2);
  const dom = new JSDOM('<textarea></textarea><input><div contenteditable="true"><span></span></div><button></button>');
  for (const selector of ['textarea', 'input', 'span']) {
    assert.equal(historyShortcut({ ctrlKey: true, key: 'z', target: dom.window.document.querySelector(selector) }), null);
  }
  assert.equal(historyShortcut({ ctrlKey: true, key: 'z', target: dom.window.document.querySelector('button') }), -1);
  assert.equal(historyShortcut({ metaKey: true, shiftKey: true, key: 'Z' }), 1);
  dom.window.close();
});
