import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { domToVDOM, parseHTML, diff, patch } from '../src/mini-react/index.js';

function setup(html) {
  const document = new JSDOM('<!doctype html><body></body>').window.document;
  const root = document.body;
  let previous = parseHTML('', document);
  function update(source) {
    const next = parseHTML(source, document);
    const changes = diff(previous, next);
    patch(root, changes);
    previous = next;
    return changes;
  }
  update(html);
  return { document, root, update };
}

test('DOM conversion preserves nesting, whitespace and comments as a snapshot', () => {
  const { root } = setup('<div id="a"> hello <b>world</b><!--note--></div>');
  const snapshot = domToVDOM(root.firstChild);
  root.firstChild.firstChild.nodeValue = 'changed';
  assert.equal(snapshot.props.id, 'a');
  assert.equal(snapshot.children[0].value, ' hello ');
  assert.equal(snapshot.children[1].type, 'b');
  assert.equal(snapshot.children[2].type, '#comment');
});

test('text and props change without replacing unaffected DOM or the text node', () => {
  const { root, update } = setup('<h1 class="old" title="x">A</h1><button>Click</button>');
  const heading = root.firstChild;
  const text = heading.firstChild;
  const button = root.lastChild;
  update('<h1 class="new">B</h1><button>Click</button>');
  assert.equal(root.firstChild, heading);
  assert.equal(heading.firstChild, text);
  assert.equal(root.lastChild, button);
  assert.equal(heading.textContent, 'B');
  assert.equal(heading.className, 'new');
  assert.equal(heading.hasAttribute('title'), false);
});

test('multiple additions, consecutive removals, replacement and empty roots', () => {
  const { root, update } = setup('<ul><li>A</li><li>B</li><li>C</li></ul><p>end</p>');
  update('<ul><li>A</li></ul><h2>end</h2>');
  assert.equal(root.innerHTML, '<ul><li>A</li></ul><h2>end</h2>');
  update('<ul><li>A</li><li>D</li><li>E</li></ul><h2>end</h2><hr><p>new</p>');
  assert.equal(root.querySelectorAll('li').length, 3);
  assert.equal(root.lastChild.textContent, 'new');
  update('');
  assert.equal(root.childNodes.length, 0);
  update('<p>again</p>');
  assert.equal(root.innerHTML, '<p>again</p>');
});

test('identical input produces no DOM mutations', () => {
  const { root, update } = setup('<p>A &amp; B</p>');
  const observer = new root.ownerDocument.defaultView.MutationObserver(() => {});
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  assert.deepEqual(update('<p>A &amp; B</p>'), []);
  assert.deepEqual(observer.takeRecords(), []);
  observer.disconnect();
});

test('position-based comparison updates reordered content in place', () => {
  const { root, update } = setup('<ul><li>A</li><li>B</li></ul>');
  const first = root.firstChild.firstChild;
  update('<ul><li>B</li><li>A</li></ul>');
  assert.equal(root.firstChild.firstChild, first);
  assert.equal(first.textContent, 'B');
});
