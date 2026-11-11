import { setProp } from './props.js';

// DOM nodes become independent snapshots, including whitespace and comments.
export function domToVDOM(node) {
  if (node.nodeType === 3 || node.nodeType === 8) {
    return {
      type: node.nodeType === 3 ? '#text' : '#comment',
      value: node.nodeValue,
    };
  }

  return {
    type: node.nodeType === 11 ? '#fragment' : node.localName,
    props: Object.fromEntries(
      Array.from(node.attributes ?? [], ({ name, value }) => [name, value]),
    ),
    children: Array.from(node.childNodes, domToVDOM),
  };
}

export function parseHTML(html, document) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return domToVDOM(template.content);
}

export function validateKeys(vnode) {
  const keys = new Set();
  for (const child of vnode.children ?? []) {
    if (child.key != null) {
      if (!(typeof child.key === 'string' || typeof child.key === 'number' && Number.isFinite(child.key))) {
        throw new Error('Keys must be strings or finite numbers.');
      }
      if (keys.has(child.key)) throw new Error('Duplicate sibling key: ' + child.key);
      keys.add(child.key);
    }
    validateKeys(child);
  }
}

export function createDOM(vnode, document) {
  validateKeys({ children: [vnode] });
  return buildDOM(vnode, document);
}

function buildDOM(vnode, document) {
  if (vnode.type === '#text') return document.createTextNode(vnode.value);
  if (vnode.type === '#comment') return document.createComment(vnode.value);

  const node = vnode.type === '#fragment'
    ? document.createDocumentFragment()
    : document.createElement(vnode.type);

  for (const [name, value] of Object.entries(vnode.props)) {
    setProp(node, name, value);
  }
  for (const child of vnode.children) {
    node.appendChild(buildDOM(child, document));
  }
  return node;
}
