import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { h, FunctionComponent, useState } from '../src/mini-react/index.js';
import { createDOMUpdateOverlay, DOM_DEBUG_COLORS } from '../src/mini-react/debug-overlay.js';
import { observePatches, patch } from '../src/mini-react/patch.js';
import { parseHTML, diff } from '../src/mini-react/index.js';

function setup() {
  const dom = new JSDOM('<body><main id="root"></main></body>');
  const { window } = dom;
  const root = window.document.querySelector('main');
  const frames = new Map();
  let id = 0;
  window.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  window.cancelAnimationFrame = request => frames.delete(request);
  const rect = (left = 0, top = 0) => ({ left, top, width: 100, height: 20 });
  window.Element.prototype.getBoundingClientRect = function () {
    return rect(Number(this.dataset.x ?? 0), Number(this.dataset.y ?? 0));
  };
  let previous = parseHTML('', window.document);
  const update = html => {
    const next = parseHTML(html, window.document);
    patch(root, diff(previous, next));
    previous = next;
  };
  const overlay = createDOMUpdateOverlay(root);
  const tick = () => {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback();
  };
  const shadow = () => window.document.querySelector('[data-mini-react-dom-overlay]')?.shadowRoot;
  const box = x => [...shadow().querySelectorAll('.box')].find(node => node.style.left === `${x}px`);
  return { window, root, update, overlay, frames, tick, shadow, box,
    close() { overlay.dispose(); dom.window.close(); } };
}

test('yellow DOM bounds turn green for exactly five debug RAF frames after Patch; unrelated changes do not count', () => {
  const context = setup();
  const { root, update, overlay, tick, box } = context;
  try {
    update('<p data-x="10">A</p><canvas data-x="20"></canvas>');
    overlay.setEnabled(true);
    tick();
    assert.equal(box(10).style.borderColor, 'rgb(250, 204, 21)');
    assert.equal(box(20).style.borderColor, 'rgb(250, 204, 21)');
    // Canvas is one element; no per-character synthetic DOM boxes are generated.
    assert.equal(context.shadow().querySelectorAll('.box').length, 3);
    update('<p data-x="10">B</p><canvas data-x="20"></canvas>');
    for (let frame = 0; frame < 5; frame++) {
      tick();
      assert.equal(box(10).style.borderColor, 'rgb(34, 197, 94)');
      assert.equal(box(20).style.borderColor, 'rgb(250, 204, 21)');
    }
    tick();
    assert.equal(box(10).style.borderColor, 'rgb(250, 204, 21)');
    root.querySelector('canvas').setAttribute('title', 'not a framework patch');
    tick();
    assert.equal(box(20).style.borderColor, 'rgb(250, 204, 21)');
    assert.equal(DOM_DEBUG_COLORS.updated, '#22c55e');
  } finally { context.close(); }
});

test('overlay follows live geometry, stays outside snapshots and fully releases RAF/DOM when disabled', () => {
  const context = setup();
  const { update, overlay, tick, root, frames, window, box } = context;
  try {
    update('<p data-x="10">A</p>');
    overlay.setEnabled(true); overlay.setEnabled(true);
    assert.equal(frames.size, 1);
    tick();
    root.querySelector('p').getBoundingClientRect = () => ({ left: 45, top: 70, width: 80, height: 25 });
    tick();
    assert.equal(box(45).style.top, '70px');
    assert.equal(box(45).style.width, '80px');
    assert.equal(window.document.body.querySelector('[data-mini-react-dom-overlay]'), null);
    overlay.setEnabled(false);
    assert.equal(frames.size, 0);
    assert.equal(window.document.querySelector('[data-mini-react-dom-overlay]'), null);
    update('<p data-x="10">B</p>');
    overlay.setEnabled(true); tick();
    assert.equal(box(45).style.borderColor, 'rgb(250, 204, 21)');
    overlay.dispose();
    assert.equal(frames.size, 0);
  } finally { context.close(); }
});

test('Patch subscribers report text parents, inserted subtrees, removal parents, replacements and ignore no-op patches', () => {
  const context = setup();
  const { root, update } = context;
  const reports = [];
  const unsubscribe = observePatches(root, elements => reports.push(elements));
  try {
    update('<p>A</p>');
    assert.deepEqual(reports.pop().map(node => node.tagName), ['P']);
    update('<p>B</p>');
    assert.deepEqual(reports.pop().map(node => node.tagName), ['P']);
    update('<p title="x">B</p><section><b>new</b></section>');
    assert.deepEqual(reports.pop().map(node => node.tagName), ['P', 'SECTION', 'B']);
    update('<p title="x">B</p>');
    assert.deepEqual(reports.pop(), [root]);
    update('<h1>B</h1>');
    assert.deepEqual(reports.pop().map(node => node.tagName), ['H1']);
    update('<h1>B</h1>');
    assert.equal(reports.length, 0);
    unsubscribe(); update('');
    assert.equal(reports.length, 0);
  } finally { unsubscribe(); context.close(); }
});

test('nested component root updates and keyed moves reach the host-root debug subscriber', async () => {
  const context = setup();
  const reports = [];
  const unsubscribe = observePatches(context.root, elements => reports.push(elements));
  let set;
  function App() {
    const [reverse, setter] = useState(false); set = setter;
    return h('div', {}, ...(reverse ? ['b', 'a'] : ['a', 'b']).map(key => h('button', { key }, key)));
  }
  const component = new FunctionComponent(App, context.root).mount();
  try {
    reports.length = 0;
    set(true); await new Promise(resolve => queueMicrotask(resolve));
    assert.ok(reports.flat().some(node => node.tagName === 'BUTTON'));
    assert.equal(context.root.textContent, 'ba');
  } finally { unsubscribe(); component.unmount(); context.close(); }
});

test('optional game-host checkbox stays outside the application root and disposes without altering game state', async () => {
  const dom = new JSDOM('<body><div id="root"><canvas></canvas></div></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  const root = window.document.getElementById('root');
  const canvas = root.firstChild;
  const states = [];
  let disposed = 0;
  const source = (await readFile(new URL('../src/dom-debug-host.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  try {
    new window.Function('createDOMUpdateOverlay', source)(observedRoot => {
      assert.equal(observedRoot, root);
      return { setEnabled: value => states.push(value), dispose: () => disposed++ };
    });
    const host = window.document.querySelector('[data-mini-react-debug-control]');
    assert.equal(host.parentElement, window.document.documentElement);
    const checkbox = host.shadowRoot.querySelector('input');
    assert.equal(checkbox.checked, false);
    checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change'));
    checkbox.checked = false; checkbox.dispatchEvent(new window.Event('change'));
    assert.deepEqual(states, [true, false]);
    assert.equal(root.firstChild, canvas);
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(disposed, 1);
    assert.equal(host.isConnected, false);
  } finally { window.close(); }
});
