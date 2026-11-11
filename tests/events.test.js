import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, FunctionComponent } from '../src/mini-react/index.js';

function mount(component) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const root = dom.window.document.querySelector('#root');
  const instance = new FunctionComponent(component, root).mount();
  return {
    window: dom.window,
    root,
    close() { instance.unmount(); dom.window.close(); },
  };
}

test('onClick receives the original native event with target and currentTarget unchanged', () => {
  let received;
  const context = mount(() => h('button', {
    onClick: event => {
      // currentTarget is only available while the listener is executing.
      received = { event, target: event.target, currentTarget: event.currentTarget };
    },
  }, h('span', {}, 'Click')));
  try {
    const button = context.root.querySelector('button');
    const span = button.querySelector('span');
    const event = new context.window.MouseEvent('click', { bubbles: true });
    span.dispatchEvent(event);

    assert.equal(received.event, event);
    assert.equal(received.target, span);
    assert.equal(received.currentTarget, button);
  } finally { context.close(); }
});

test('a nested span click bubbles through framework button and parent handlers in order', () => {
  const received = [];
  const handler = name => event => received.push({ name, event, target: event.target, currentTarget: event.currentTarget });
  const context = mount(() => h('section', { onClick: handler('parent') },
    h('button', { onClick: handler('button') }, h('span', {}, 'Click'))));
  try {
    const parent = context.root.querySelector('section');
    const button = parent.querySelector('button');
    const span = button.querySelector('span');
    const event = new context.window.MouseEvent('click', { bubbles: true });
    span.dispatchEvent(event);

    assert.deepEqual(received.map(item => item.name), ['button', 'parent']);
    assert.ok(received.every(item => item.event === event && item.target === span));
    assert.equal(received[0].currentTarget, button);
    assert.equal(received[1].currentTarget, parent);
  } finally { context.close(); }
});

test('stopPropagation in a framework child handler prevents its parent handler', () => {
  const calls = [];
  const context = mount(() => h('section', { onClick: () => calls.push('parent') },
    h('button', { onClick: event => { calls.push('button'); event.stopPropagation(); } },
      h('span', {}, 'Click'))));
  try {
    const event = new context.window.MouseEvent('click', { bubbles: true, cancelable: true });
    const accepted = context.root.querySelector('span').dispatchEvent(event);

    assert.deepEqual(calls, ['button']);
    assert.equal(event.defaultPrevented, false);
    assert.equal(accepted, true);
  } finally { context.close(); }
});

test('parent target filtering skips only its own action without stopping ancestor bubbling', () => {
  const calls = [];
  const context = mount(() => h('article', { onClick: () => calls.push('ancestor') },
    h('section', {
      onClick: event => {
        if (event.target.closest('[data-delete]')) return;
        calls.push('open-detail');
      },
    },
    h('button', { 'data-delete': '', onClick: () => calls.push('delete') }, h('span', {}, 'Delete')),
    h('p', {}, 'Open detail'))));
  try {
    context.root.querySelector('span').dispatchEvent(new context.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, ['delete', 'ancestor']);

    calls.length = 0;
    context.root.querySelector('p').dispatchEvent(new context.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, ['open-detail', 'ancestor']);
  } finally { context.close(); }
});

test('preventDefault cancels a cancelable event while framework parent handlers still receive it', () => {
  const calls = [];
  let parentEvent;
  const context = mount(() => h('section', {
    onClick: event => { calls.push('parent'); parentEvent = event; },
  }, h('button', {
    onClick: event => { calls.push('button'); event.preventDefault(); },
  }, h('span', {}, 'Click'))));
  try {
    const event = new context.window.MouseEvent('click', { bubbles: true, cancelable: true });
    const accepted = context.root.querySelector('span').dispatchEvent(event);

    assert.deepEqual(calls, ['button', 'parent']);
    assert.equal(parentEvent, event);
    assert.equal(parentEvent.defaultPrevented, true);
    assert.equal(accepted, false);
  } finally { context.close(); }
});
