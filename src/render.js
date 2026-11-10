export function setDomProp(element, name, value) {
  if (name.startsWith("on") && typeof value === "function") {
    element[name.toLowerCase()] = value;
    return;
  }

  if (name.startsWith("on")) element[name.toLowerCase()] = null;
  element.setAttribute(name, value);
}

export function removeDomProp(element, name) {
  if (name.startsWith("on")) element[name.toLowerCase()] = null;
  element.removeAttribute(name);
}

export function vdomToDom(vnode, documentRef = globalThis.document) {
  if (typeof vnode === "string") {
    return documentRef.createTextNode(vnode);
  }

  const element = documentRef.createElement(vnode.type);

  for (const [name, value] of Object.entries(vnode.props)) {
    setDomProp(element, name, value);
  }

  for (const child of vnode.children) {
    element.appendChild(vdomToDom(child, documentRef));
  }

  return element;
}
