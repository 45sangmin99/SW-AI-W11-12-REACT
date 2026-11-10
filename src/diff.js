function getKey(vnode) {
  return typeof vnode === "object" && vnode !== null
    ? vnode.props?.key
    : undefined;
}

function compareProps(oldProps, newProps, path, patches) {
  const set = Object.fromEntries(
    Object.entries(newProps).filter(([name, value]) => oldProps[name] !== value),
  );
  const remove = Object.keys(oldProps).filter(
    (name) => !Object.hasOwn(newProps, name),
  );

  if (Object.keys(set).length || remove.length) {
    patches.push({ type: "UPDATE_PROPS", path, set, remove });
  }
}

function keyedChildren(children) {
  const keyed = new Map();

  children.forEach((child, index) => {
    const key = getKey(child);

    if (key === undefined) {
      throw new TypeError("Keyed children must all have a key.");
    }
    if (keyed.has(key)) {
      throw new TypeError(`Duplicate key: ${key}`);
    }

    keyed.set(key, { child, index });
  });

  return keyed;
}

function compareKeyedChildren(oldChildren, newChildren, path, patches) {
  const oldKeyed = keyedChildren(oldChildren);
  const newKeyed = keyedChildren(newChildren);

  for (const [key, { index }] of oldKeyed) {
    if (!newKeyed.has(key)) {
      patches.push({ type: "REMOVE", path: [...path, index], key });
    }
  }

  for (const [key, { child, index }] of newKeyed) {
    const previous = oldKeyed.get(key);

    if (!previous) {
      patches.push({ type: "CREATE", path: [...path, index], node: child, key });
      continue;
    }

    if (previous.index !== index) {
      patches.push({ type: "MOVE", path, key, to: index });
    }

    compare(previous.child, child, [...path, index], patches);
  }
}

function compareChildren(oldChildren, newChildren, path, patches) {
  const usesKeys = [...oldChildren, ...newChildren].some(
    (child) => getKey(child) !== undefined,
  );

  if (usesKeys) {
    compareKeyedChildren(oldChildren, newChildren, path, patches);
    return;
  }

  const commonLength = Math.min(oldChildren.length, newChildren.length);

  for (let index = 0; index < commonLength; index += 1) {
    compare(oldChildren[index], newChildren[index], [...path, index], patches);
  }

  for (let index = oldChildren.length - 1; index >= newChildren.length; index -= 1) {
    compare(oldChildren[index], undefined, [...path, index], patches);
  }

  for (let index = oldChildren.length; index < newChildren.length; index += 1) {
    compare(undefined, newChildren[index], [...path, index], patches);
  }
}

function compare(oldVNode, newVNode, path, patches) {
  if (oldVNode == null) {
    if (newVNode != null) {
      patches.push({ type: "CREATE", path, node: newVNode });
    }
    return;
  }

  if (newVNode == null) {
    patches.push({ type: "REMOVE", path });
    return;
  }

  const oldIsText = typeof oldVNode === "string";
  const newIsText = typeof newVNode === "string";

  if (oldIsText || newIsText) {
    if (oldIsText && newIsText) {
      if (oldVNode !== newVNode) {
        patches.push({ type: "UPDATE_TEXT", path, value: newVNode });
      }
    } else {
      patches.push({ type: "REPLACE", path, node: newVNode });
    }
    return;
  }

  if (oldVNode.type !== newVNode.type) {
    patches.push({ type: "REPLACE", path, node: newVNode });
    return;
  }

  compareProps(oldVNode.props, newVNode.props, path, patches);
  compareChildren(oldVNode.children, newVNode.children, path, patches);
}

export function diff(oldVNode, newVNode) {
  const patches = [];
  compare(oldVNode, newVNode, [], patches);
  return patches;
}
