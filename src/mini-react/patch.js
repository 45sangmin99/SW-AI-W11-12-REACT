import { setProp, disposeDOM } from './props.js';
import { createDOM } from './vdom.js';

const observers = new WeakMap();

// Debug subscribers receive explicit Patch targets, not unrelated DOM mutations.
export function observePatches(root, listener) {
  const document = root.ownerDocument;
  const entries = observers.get(document) ?? new Set();
  const entry = { root, listener };
  entries.add(entry);
  observers.set(document, entries);
  return () => {
    entries.delete(entry);
    if (!entries.size) observers.delete(document);
  };
}

function findNode(root, path) {
  let node = root;
  for (const index of path) node = node.childNodes[index];
  return node;
}

export function patch(root, changes) {
  const subscribers = observers.get(root.ownerDocument);
  const updated = subscribers?.size ? new Set() : null;
  function mark(node, descendants = false) {
    if (!updated || !node) return;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return;
    updated.add(element);
    if (descendants) for (const child of element.querySelectorAll('*')) updated.add(child);
  }
  // Resolve against the original tree before deletions shift child indexes.
  const targets = changes.map((change) => ({
    change,
    node: findNode(root, change.path),
    children: change.type === 'CHILDREN' ? Array.from(findNode(root, change.path).childNodes) : null,
    parent: change.path.length ? findNode(root, change.path.slice(0, -1)) : null,
  }));

  for (const { change, node, parent, children } of targets) {
    switch (change.type) {
      case 'CHILDREN': {
        for (const index of change.remove) {
          mark(node);
          disposeDOM(children[index]);
          children[index].remove();
        }
        change.items.forEach((item, index) => {
          const child = item.oldIndex === undefined ? createDOM(item.vnode, root.ownerDocument) : children[item.oldIndex];
          if (node.childNodes[index] !== child) {
            node.insertBefore(child, node.childNodes[index] ?? null);
            mark(child, item.oldIndex === undefined);
          }
        });
        break;
      }
      case 'ADD': {
        const added = createDOM(change.vnode, root.ownerDocument);
        parent.insertBefore(added, node ?? null);
        mark(added, true);
        break;
      }
      case 'REMOVE':
        mark(node.parentElement);
        disposeDOM(node);
        node.remove();
        break;
      case 'REPLACE': {
        const replacement = createDOM(change.vnode, root.ownerDocument);
        disposeDOM(node);
        node.replaceWith(replacement);
        mark(replacement, true);
        break;
      }
      case 'TEXT':
        node.nodeValue = change.value;
        mark(node);
        break;
      case 'PROPS':
        mark(node);
        for (const name of change.remove) {
          setProp(node, name, undefined, change.previous?.[name]);
        }
        for (const [name, value] of Object.entries(change.set)) {
          setProp(node, name, value, change.previous?.[name]);
        }
        break;
    }
  }
  if (updated?.size) {
    for (const { root: observedRoot, listener } of subscribers) {
      const elements = [...updated].filter(element => element === observedRoot || observedRoot.contains(element));
      if (elements.length) listener(elements);
    }
  }
}
