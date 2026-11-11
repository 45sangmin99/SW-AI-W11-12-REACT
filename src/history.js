// Clone data while retaining functions and external handles by identity.
// Functions, DOM nodes and class instances are not a reversible external world.
export function cloneData(value, seen = new Map()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Date]') return new Date(value.getTime());
  if (tag === '[object Map]') {
    const copy = new Map(); seen.set(value, copy);
    for (const [key, item] of value) copy.set(cloneData(key, seen), cloneData(item, seen));
    return copy;
  }
  if (tag === '[object Set]') {
    const copy = new Set(); seen.set(value, copy);
    for (const item of value) copy.add(cloneData(item, seen));
    return copy;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value)?.constructor?.name !== 'Object') return value;
  // Resource controllers commonly expose methods; preserve their identity.
  if (!Array.isArray(value) && Object.values(value).some(item => typeof item === 'function')) return value;
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = cloneData(value[key], seen);
  return copy;
}

export function createHistory() {
  let entries = [];
  let index = -1;
  return {
    record(snapshot, fingerprint) {
      const entry = { snapshot, fingerprint };
      if (entries[index]?.fingerprint === fingerprint) {
        // Keep current callbacks/source even when the visible tree is unchanged.
        entries[index] = entry;
        return;
      }
      entries = entries.slice(0, index + 1);
      entries.push(entry);
      index = entries.length - 1;
    },
    target(offset) { return entries[index + offset]?.snapshot; },
    move(offset) {
      if (!entries[index + offset]) return false;
      index += offset;
      return true;
    },
    get state() { return { index, length: entries.length, canBack: index > 0, canForward: index >= 0 && index < entries.length - 1 }; },
  };
}

export function historyShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return null;
  const target = event.target;
  if (target?.closest?.('textarea, input, select, [contenteditable]:not([contenteditable="false"])')) return null;
  return event.shiftKey ? 1 : -1;
}
