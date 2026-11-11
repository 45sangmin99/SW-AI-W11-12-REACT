import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { loadRuntime, previewDocument } from '../src/playground.js';
import { createPreviewController } from '../src/preview-controller.js';
import { initialDocument } from '../src/example.js';
import { historyShortcut } from '../src/history.js';

const runtimeURL = await loadRuntime(new URL('../src/mini-react/index.js', import.meta.url).href,
  url => readFile(new URL(url), 'utf8'));
const runtime = await import(runtimeURL);
const flush = async () => {
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));
};

function setup() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only' });
  const { window } = dom;
  const intervals = new Map();
  let timerId = 0;
  window.setInterval = callback => { const id = ++timerId; intervals.set(id, callback); return id; };
  window.clearInterval = id => intervals.delete(id);
  const reports = [];
  const controller = createPreviewController(window, runtime, (type, message) => reports.push({ type, message }));
  return {
    window, controller, reports, intervals,
    async tick() { for (const callback of [...intervals.values()]) callback(); await flush(); },
    close() { controller.dispose(); dom.window.close(); },
  };
}

const instrumented = initialDocument.replace('function search(walls, start, end) {',
  'function search(walls, start, end) { window.searchCalls = (window.searchCalls ?? 0) + 1;');

test('bootstrap loads the controller once instead of putting editable source into srcdoc', () => {
  const bootstrap = previewDocument(runtimeURL, 'data:text/javascript,controller');
  assert.match(bootstrap, /startPreview\(window, runtime\)/);
  assert.doesNotMatch(bootstrap, /function App|길찾기 격자/);
  assert.equal(typeof runtime.FunctionComponent, 'function');
});

test('pathfinding plays, pauses, caches BFS and keeps state/DOM during compatible source updates', async () => {
  const context = setup();
  const { window, controller, intervals } = context;
  const document = window.document;
  try {
    assert.equal(controller.apply(instrumented), true);
    const root = document.getElementById('root');
    const cell = id => root.querySelector('[data-cell="' + id + '"]');
    const tool = name => root.querySelector('[data-tool="' + name + '"]');
    const click = async node => { node.click(); await flush(); };
    assert.equal(root.querySelectorAll('.cell').length, 216);
    assert.equal(window.searchCalls, 1);
    const originalCell = cell(0);
    cell(19).dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, buttons: 1, bubbles: true }));
    await flush();
    cell(20).dispatchEvent(new window.MouseEvent('pointerenter', { buttons: 1 }));
    await flush();
    assert.ok(cell(19).classList.contains('wall'));
    assert.ok(cell(20).classList.contains('wall'));
    window.dispatchEvent(new window.Event('pointerup'));
    await flush();
    cell(21).dispatchEvent(new window.MouseEvent('pointerenter', { buttons: 1 }));
    await flush();
    assert.ok(!cell(21).classList.contains('wall'));

    const edited = instrumented.replace("h('h1', {}, '길찾기')", "h('h1', {}, '수정한 길찾기')")
      .replace('background: #f8fafc', 'background: #f0fdf4');
    assert.equal(controller.apply(edited), true);
    assert.equal(document.getElementById('root'), root);
    assert.equal(cell(0), originalCell);
    assert.ok(cell(19).classList.contains('wall'));
    assert.match(root.querySelector('h1').textContent, /수정한/);
    assert.match(document.querySelector('style').textContent, /#f0fdf4/);
    await click(cell(19)); // Old state setter and new event callback must still work.
    assert.ok(!cell(19).classList.contains('wall'));
    await click(cell(19));
    assert.ok(cell(19).classList.contains('wall'));

    await click(root.querySelector('#clear'));
    await click(tool('start'));
    await click(cell(0));
    await click(tool('end'));
    await click(cell(3));
    const searches = window.searchCalls;
    await click(root.querySelector('#play'));
    assert.equal(intervals.size, 1);
    await context.tick();
    assert.equal(window.searchCalls, searches);
    assert.ok(root.querySelectorAll('.frontier').length > 0);
    assert.equal(root.querySelectorAll('.cell').length, 216);

    // A code edit while playing swaps effects, rather than accumulating timers.
    assert.equal(controller.apply(edited.replace('35);', '70);')), true);
    assert.equal(intervals.size, 1);
    const searchesAfterEdit = window.searchCalls;
    await context.tick();
    assert.equal(window.searchCalls, searchesAfterEdit);
    await click(root.querySelector('#play'));
    assert.equal(intervals.size, 0);
    const paused = root.innerHTML;
    await context.tick();
    assert.equal(root.innerHTML, paused);
    await click(root.querySelector('#play'));
    for (let i = 0; i < 40 && intervals.size; i++) await context.tick();
    assert.equal(intervals.size, 0);
    assert.match(root.querySelector('[role="status"]').textContent, /최단 거리 3칸/);
    assert.equal(root.querySelectorAll('.path').length, 2);
    assert.equal(cell(0), originalCell);

    await click(tool('wall'));
    await click(cell(1));
    await click(cell(18));
    await click(root.querySelector('#play'));
    await context.tick();
    assert.match(root.querySelector('[role="status"]').textContent, /길이 없습니다/);
    assert.equal(intervals.size, 0);
    await click(root.querySelector('#clear'));
    await click(root.querySelector('#play'));
    assert.equal(intervals.size, 1);
    controller.dispose();
    assert.equal(intervals.size, 0);
  } finally { context.close(); }
});

test('syntax errors, failed render and incompatible hooks retain last working UI, state and callbacks', async () => {
  const context = setup();
  const { controller, window, reports } = context;
  const source = `<div id="root"></div><script type="module">
    import { h, FunctionComponent, useState, useMemo, useEffect } from 'mini-react';
    function App() {
      const [count, setCount] = useState(0);
      const doubled = useMemo(() => count * 2, [count]);
      useEffect(() => {
        window.starts = (window.starts ?? 0) + 1;
        return () => { window.stops = (window.stops ?? 0) + 1; };
      }, []);
      return h('button', { onClick: () => setCount(n => n + 1) }, '값 ', count, ' / ', doubled);
    }
    new FunctionComponent(App, document.querySelector('#root')).mount();
  </script>`;
  try {
    assert.equal(controller.apply(source), true);
    const root = window.document.getElementById('root');
    const button = root.firstChild;
    button.click();
    await flush();
    assert.equal(button.textContent, '값 1 / 2');
    assert.equal(controller.apply(source.replace('const [count,', 'const [count,' + '(')), false);
    assert.equal(window.document.getElementById('root'), root);
    assert.equal(root.firstChild, button);
    assert.equal(button.textContent, '값 1 / 2');
    assert.equal(window.starts, 1);
    assert.equal(window.stops, undefined);
    assert.equal(controller.apply(source.replace('const doubled =', 'useState(99); const doubled =')), false);
    assert.match(reports.at(-1).message, /Hook/);
    assert.equal(window.starts, 1);
    button.click();
    await flush();
    assert.equal(button.textContent, '값 2 / 4');
    assert.equal(controller.apply(source.replace("return h('button'", "throw new Error('렌더 실패'); return h('button'")), false);
    assert.equal(button.textContent, '값 2 / 4');
    const edited = source.replace('count * 2', 'count * 3').replace('n + 1', 'n + 2');
    assert.equal(controller.apply(edited), true);
    assert.equal(root.firstChild, button);
    assert.equal(button.textContent, '값 2 / 6'); // Memo factory refreshed even with same deps.
    assert.equal(window.starts, 2);
    assert.equal(window.stops, 1);
    button.click();
    await flush();
    assert.equal(button.textContent, '값 4 / 12'); // New callback replaces old callback.
    controller.dispose();
    assert.equal(window.stops, 2);
  } finally { context.close(); }
});

test('plain inline DOM scripts work, replace listeners and leave working DOM on invalid edits', async () => {
  const context = setup();
  const { controller, window } = context;
  const source = `<style>button { color: red; }</style><button id="button">0</button>
    <script>
      const button = document.querySelector('#button');
      button.addEventListener('click', () => { button.textContent = Number(button.textContent) + 1; });
    </script>`;
  try {
    assert.equal(controller.apply(source), true);
    const button = window.document.getElementById('button');
    button.click();
    assert.equal(button.textContent, '1');
    const updated = source.replace('+ 1', '+ 2').replace('>0<', '>10<');
    assert.equal(controller.apply(updated), true);
    assert.equal(window.document.getElementById('button'), button);
    assert.equal(button.textContent, '10');
    button.click();
    assert.equal(button.textContent, '12');
    assert.equal(controller.apply(updated.replace('const button =', 'throw new Error("失敗"); const button =')), false);
    button.click();
    assert.equal(button.textContent, '14');
  } finally { context.close(); }
});

test('editor auto-updates over messages without navigating or replacing its iframe', async () => {
  const dom = new JSDOM('<button id="patch" disabled>Patch</button><input id="auto-apply" type="checkbox" checked><input id="dom-debug" type="checkbox"><button id="history-back" disabled></button><button id="history-forward" disabled></button><span id="history-position"></span><textarea id="editor"></textarea><p id="status"></p><iframe id="preview"></iframe>', { runScripts: 'outside-only' });
  const { window } = dom;
  const preview = window.document.querySelector('iframe');
  const previewWindow = preview.contentWindow;
  const editor = window.document.querySelector('textarea');
  const messages = [];
  const debugMessages = [];
  const timers = new Map();
  let navigationCount = 0;
  let timerId = 0;
  Object.defineProperty(preview, 'srcdoc', { set() { navigationCount++; } });
  previewWindow.postMessage = value => (value.type === 'dom-debug' ? debugMessages : messages).push(value);
  window.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  window.clearTimeout = id => timers.delete(id);
  let source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost/src/app.js'));
  const execute = new window.Function('loadRuntime', 'previewDocument', 'initialDocument', 'historyShortcut',
    'return (async () => {' + source + '})();');
  try {
    await execute(async () => 'data:text/javascript,runtime', () => '<html></html>', '<div>처음</div>', historyShortcut);
    assert.equal(navigationCount, 1);
    window.dispatchEvent(new window.MessageEvent('message', {
      source: previewWindow, data: { playground: true, type: 'ready' },
    }));
    assert.equal(messages.length, 1);
    const domDebug = window.document.querySelector('#dom-debug');
    assert.equal(debugMessages.at(-1).enabled, false);
    domDebug.checked = true;
    domDebug.dispatchEvent(new window.Event('change'));
    assert.equal(debugMessages.at(-1).enabled, true);
    domDebug.checked = false;
    domDebug.dispatchEvent(new window.Event('change'));
    assert.equal(debugMessages.at(-1).enabled, false);
    assert.equal(messages.length, 1);
    editor.value = '<div>수정 1</div>';
    editor.dispatchEvent(new window.Event('input'));
    editor.value = '<div>수정 2</div>';
    editor.dispatchEvent(new window.Event('input'));
    assert.equal(timers.size, 1);
    for (const callback of timers.values()) callback();
    assert.equal(messages.length, 2);
    assert.equal(messages[1].source, '<div>수정 2</div>');
    const autoApply = window.document.querySelector('#auto-apply');
    const patchButton = window.document.querySelector('#patch');
    assert.equal(patchButton.disabled, false);

    // Turning auto-apply off cancels even an already scheduled edit.
    editor.value = '<div>수정 대기</div>';
    editor.dispatchEvent(new window.Event('input'));
    autoApply.checked = false;
    autoApply.dispatchEvent(new window.Event('change'));
    assert.equal(timers.size, 0);
    editor.dispatchEvent(new window.Event('input'));
    assert.equal(timers.size, 0);
    assert.equal(messages.length, 2);
    patchButton.click();
    assert.equal(messages.length, 3);
    assert.equal(messages[2].source, '<div>수정 대기</div>');

    // Re-enabling applies the current draft immediately.
    editor.value = '<div>자동 재개</div>';
    autoApply.checked = true;
    autoApply.dispatchEvent(new window.Event('change'));
    assert.equal(messages.length, 4);
    assert.equal(messages[3].source, '<div>자동 재개</div>');

    // Manual Patch cancels a pending automatic apply to avoid duplicate sends.
    editor.dispatchEvent(new window.Event('input'));
    assert.equal(timers.size, 1);
    patchButton.click();
    assert.equal(timers.size, 0);
    assert.equal(messages.length, 5);
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    assert.equal(messages.length, 6);
    const showHistory = state => window.dispatchEvent(new window.MessageEvent('message', {
      source: previewWindow, data: { playground: true, type: 'history', message: state, revision: messages.at(-1).revision },
    }));
    showHistory({ index: 1, length: 2, canBack: true, canForward: false });
    assert.equal(window.document.querySelector('#history-back').disabled, false);
    assert.equal(window.document.querySelector('#history-forward').disabled, true);
    assert.equal(window.document.querySelector('#history-position').textContent, '2 / 2');
    editor.dispatchEvent(new window.Event('input'));
    window.document.querySelector('#history-back').click();
    assert.equal(timers.size, 0);
    assert.equal(messages.at(-1).type, 'history');
    assert.equal(messages.at(-1).offset, -1);
    assert.equal(editor.value, '<div>자동 재개</div>');
    // Code editing keeps native undo; window shortcuts navigate VDOM snapshots.
    const count = messages.length;
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(messages.length, count);
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, cancelable: true }));
    assert.equal(messages.at(-1).offset, 1);
    assert.equal(navigationCount, 1);
    assert.equal(preview.contentWindow, previewWindow);
  } finally { dom.window.close(); }
});
