import { removeDomProp, setDomProp, vdomToDom } from "./render.js";

function vdomChildren(node) {
  return Array.from(node.childNodes).filter(
    (child) => child.nodeType === 1
      || (child.nodeType === 3 && child.nodeValue.trim()),
  );
}

function nodeAtPath(root, path) {
  return path.reduce((node, index) => vdomChildren(node)[index], root);
}

function keyedChild(parent, key) {
  return Array.from(parent.childNodes).find(
    (child) => child.nodeType === 1 && child.getAttribute("key") === String(key),
  );
}

export function patch(root, patches, documentRef = globalThis.document) {
  let currentRoot = root;

  for (const change of patches) {
    if (change.type === "CREATE") {
      const created = vdomToDom(change.node, documentRef);

      if (change.path.length === 0) {
        currentRoot = created;
      } else {
        const parent = nodeAtPath(currentRoot, change.path.slice(0, -1));
        const index = change.path.at(-1);
        parent.insertBefore(created, vdomChildren(parent)[index] ?? null);
      }
      continue;
    }

    if (change.type === "REMOVE") {
      if (change.path.length === 0) {
        currentRoot?.remove();
        currentRoot = null;
      } else {
        const parent = nodeAtPath(currentRoot, change.path.slice(0, -1));
        const target = change.key === undefined
          ? vdomChildren(parent)[change.path.at(-1)]
          : keyedChild(parent, change.key);
        target.remove();
      }
      continue;
    }

    if (change.type === "MOVE") {
      const parent = nodeAtPath(currentRoot, change.path);
      const target = keyedChild(parent, change.key);
      target.remove();
      parent.insertBefore(target, vdomChildren(parent)[change.to] ?? null);
      continue;
    }

    const target = nodeAtPath(currentRoot, change.path);

    if (change.type === "REPLACE") {
      const replacement = vdomToDom(change.node, documentRef);
      target.replaceWith(replacement);
      if (change.path.length === 0) {
        currentRoot = replacement;
      }
    } else if (change.type === "UPDATE_TEXT") {
      target.nodeValue = change.value;
    } else if (change.type === "UPDATE_PROPS") {
      change.remove.forEach((name) => removeDomProp(target, name));
      Object.entries(change.set).forEach(([name, value]) => {
        setDomProp(target, name, value);
      });
    }
  }

  return currentRoot;
}
