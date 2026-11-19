export function createHistory(initialState) {
  const entries = [structuredClone(initialState)];
  let index = 0;

  const current = () => structuredClone(entries[index]);

  return {
    get canBack() {
      return index > 0;
    },
    get canForward() {
      return index < entries.length - 1;
    },
    get position() {
      return index + 1;
    },
    get length() {
      return entries.length;
    },
    get current() {
      return current();
    },
    push(state) {
      entries.splice(index + 1);
      entries.push(structuredClone(state));
      index = entries.length - 1;
      return current();
    },
    back() {
      if (index > 0) index -= 1;
      return current();
    },
    forward() {
      if (index < entries.length - 1) index += 1;
      return current();
    },
  };
}
