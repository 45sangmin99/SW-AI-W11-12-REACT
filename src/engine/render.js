function isBooleanFormProp(name) {
  return name === "checked" || name === "selected" || name === "disabled";
}

function syncTextValue(element, value) {
  const tag = element.tagName.toLowerCase();
  if ((tag === "textarea" || (tag === "input" && element.type !== "file"))
    && "value" in element && element.value !== value) {
    element.value = value;
  }
}

export function setDomProp(element, name, value) {
  if (name.startsWith("on") && typeof value === "function") {
    element[name.toLowerCase()] = value;
    return;
  }

  if (name.startsWith("on")) element[name.toLowerCase()] = null;
  if (isBooleanFormProp(name) && (value === false || value == null)) {
    removeDomProp(element, name);
    return;
  }
  element.setAttribute(name, value);
  if (name === "value") syncTextValue(element, String(value));
  if (isBooleanFormProp(name) && name in element && !element[name]) element[name] = true;
}

export function removeDomProp(element, name) {
  if (name.startsWith("on")) element[name.toLowerCase()] = null;
  element.removeAttribute(name);
  if (name === "value") syncTextValue(element, "");
  if (isBooleanFormProp(name) && name in element && element[name]) element[name] = false;
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
