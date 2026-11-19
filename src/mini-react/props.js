const listeners = new WeakMap();

// Function props such as onClick become DOM listeners rather than attributes.
export function setProp(node, name, value, previous) {
  if (name === 'key') return;
  if (/^on[A-Z]/.test(name)) {
    const event = name.slice(2).toLowerCase();
    if (typeof previous === 'function') node.removeEventListener(event, previous);
    const registered = listeners.get(node) ?? new Map();
    const old = registered.get(event);
    if (old && old !== previous) node.removeEventListener(event, old);
    registered.delete(event);
    if (typeof value === 'function') {
      node.addEventListener(event, value);
      registered.set(event, value);
    }
    listeners.set(node, registered);
  } else if (value == null || value === false) {
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value === true ? '' : value);
  }

  // Edited form controls keep a live value separate from their HTML attribute.
  if (name === 'value' && (node.localName === 'input' || node.localName === 'textarea')) {
    const nextValue = value == null || typeof value === 'boolean' ? '' : String(value);
    // Browsers only allow clearing a file input, never assigning its filename.
    if ((node.type !== 'file' || nextValue === '') && node.value !== nextValue) {
      node.value = nextValue;
    }
  }
}

// Release handlers even when callers retain a removed node reference.
export function disposeDOM(node) {
  for (const [event, listener] of listeners.get(node) ?? []) node.removeEventListener(event, listener);
  listeners.delete(node);
  for (const child of node.childNodes) disposeDOM(child);
}
