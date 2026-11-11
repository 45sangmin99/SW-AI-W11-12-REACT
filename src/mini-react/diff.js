import { validateKeys } from './vdom.js';

export function diff(oldNode, newNode, path = []) {
  if (path.length === 0) {
    if (oldNode) validateKeys({ children: [oldNode] });
    if (newNode) validateKeys({ children: [newNode] });
  }
  if (!oldNode) return newNode ? [{ type: 'ADD', path, vnode: newNode }] : [];
  if (!newNode) return [{ type: 'REMOVE', path }];
  if (oldNode.type !== newNode.type || (oldNode.key ?? null) !== (newNode.key ?? null)) {
    return [{ type: 'REPLACE', path, vnode: newNode }];
  }

  if (oldNode.type === '#text' || oldNode.type === '#comment') {
    return oldNode.value === newNode.value
      ? []
      : [{ type: 'TEXT', path, value: newNode.value }];
  }

  const changes = [];
  const set = {};
  const remove = [];
  for (const [name, value] of Object.entries(newNode.props)) {
    if (oldNode.props[name] !== value) set[name] = value;
  }
  for (const name of Object.keys(oldNode.props)) {
    if (!Object.hasOwn(newNode.props, name)) remove.push(name);
  }
  if (Object.keys(set).length || remove.length) {
    changes.push({ type: 'PROPS', path, set, remove, previous: oldNode.props });
  }

  const oldChildren = oldNode.children, newChildren = newNode.children;
  if (oldChildren.some(child => child.key != null) || newChildren.some(child => child.key != null)) {
    const keyed = new Map(oldChildren.flatMap((child, index) => child.key == null ? [] : [[child.key, index]]));
    const used = new Set();
    const items = newChildren.map((child, index) => {
      const oldIndex = child.key != null ? keyed.get(child.key)
        : oldChildren[index]?.key == null && oldChildren[index] ? index : undefined;
      if (oldIndex === undefined) return { vnode: child };
      used.add(oldIndex);
      return { oldIndex };
    });
    if (items.length !== oldChildren.length || items.some((item, i) => item.oldIndex !== i)) {
      changes.push({ type: 'CHILDREN', path, items, remove: oldChildren.flatMap((_, i) => used.has(i) ? [] : [i]) });
    }
    for (let index = 0; index < items.length; index++) {
      const oldIndex = items[index].oldIndex;
      if (oldIndex !== undefined) changes.push(...diff(oldChildren[oldIndex], newChildren[index], [...path, oldIndex]));
    }
  } else {
    const length = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < length; i++) changes.push(...diff(oldChildren[i], newChildren[i], [...path, i]));
  }
  return changes;
}
