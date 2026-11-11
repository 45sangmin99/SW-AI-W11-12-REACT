import { disposeDOM } from './props.js';
import { diff } from './diff.js';
import { patch } from './patch.js';

let current = null;

// Function children stay unevaluated until after the root has finished rendering.
export function h(type, props = {}, ...children) {
  const { key, ...attributes } = props ?? {};
  return { type, ...(key == null ? {} : { key }), props: attributes, children: children.flat(Infinity) };
}

function resolve(value) {
  if (value == null || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(resolve);
  if (typeof value !== 'object') return [{ type: '#text', value: String(value) }];
  if (typeof value.type === 'function') {
    const result = resolve(value.type({ ...value.props, children: value.children }));
    if (value.key != null) {
      if (result.length !== 1) throw new Error('A keyed component must return exactly one DOM node.');
      return [{ ...result[0], key: value.key }];
    }
    return result;
  }
  if (value.type === '#text' || value.type === '#comment') return [value];
  const children = (value.children ?? []).flatMap(resolve);
  return value.type === '#fragment' ? children : [{ ...value, children }];
}

function hook(kind) {
  if (!current) throw new Error('Hooks are only allowed in the root component.');
  const component = current;
  const index = component.hookIndex++;
  let slot = component.hooks[index];
  if (!slot) {
    if (component.rendered) throw new Error('Hook count must stay the same.');
    slot = component.hooks[index] = { kind, index };
  }
  if (slot.kind !== kind) throw new Error('Hook order must stay the same.');
  return [component, slot];
}

function sameDeps(previous, next) {
  return previous !== undefined && next !== undefined
    && previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));
}

export function useState(initialValue) {
  const [component, slot] = hook('state');
  if (!slot.initialized) {
    slot.value = typeof initialValue === 'function' ? initialValue() : initialValue;
    slot.set = (next) => {
      if (current) throw new Error('State cannot be changed during rendering.');
      if (!component.mounted) return;
      const active = component.hooks[slot.index];
      const value = typeof next === 'function' ? next(active.value) : next;
      if (Object.is(value, active.value)) return;
      active.value = value;
      component.scheduleUpdate();
    };
    slot.initialized = true;
  }
  return [slot.value, slot.set];
}

export function useMemo(factory, deps) {
  const [, slot] = hook('memo');
  if (current.refreshing || !slot.initialized || !sameDeps(slot.deps, deps)) {
    slot.value = factory();
    slot.deps = deps?.slice();
    slot.initialized = true;
  }
  return slot.value;
}

export function useEffect(effect, deps) {
  const [component, slot] = hook('effect');
  if (current.refreshing || !slot.initialized || !sameDeps(slot.deps, deps)) {
    component.effects.push(() => {
      try { slot.cleanup?.(); } catch (error) {
        if (component.onError) component.onError(error); else throw error;
      }
      slot.cleanup = undefined;
      slot.deps = deps?.slice();
      slot.initialized = true;
      const cleanup = effect();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    });
  }
}

export class FunctionComponent {
  constructor(component, root, props = {}) {
    this.component = component;
    this.root = root;
    this.props = props;
    this.hooks = [];
    this.vdom = { type: '#fragment', props: {}, children: [] };
    this.mounted = false;
    this.rendered = false;
    this.pending = false;
  }

  mount() {
    if (this.mounted) throw new Error('Component is already mounted.');
    if (this.rendered) throw new Error('Create a new instance to remount.');
    if (this.root.childNodes.length) throw new Error('Mount requires an empty root.');
    this.mounted = true;
    try {
      this.update();
    } catch (error) {
      this.mounted = false;
      throw error;
    }
    return this;
  }

  scheduleUpdate() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.mounted) this.update();
    });
  }

  // Render against copied slots first. A bad edit must not touch live hooks or DOM.
  prepareReplacement(component = this.component, props = this.props, refreshing = true) {
    if (current) throw new Error('Cannot render a component during rendering.');
    const previous = {
      hooks: this.hooks, hookIndex: this.hookIndex, effects: this.effects,
      refreshing: this.refreshing,
    };
    this.hooks = this.hooks.map(slot => ({ ...slot }));
    this.hookIndex = 0;
    this.effects = [];
    this.refreshing = refreshing;
    let output;
    current = this;
    try {
      output = component(props);
      if (this.rendered && this.hookIndex !== previous.hooks.length) {
        throw new Error('Hook count must stay the same.');
      }
    } catch (error) {
      Object.assign(this, previous);
      throw error;
    } finally {
      current = null;
    }
    try {
      const next = { type: '#fragment', props: {}, children: resolve(output) };
      return { component, props, hooks: this.hooks, effects: this.effects, next };
    } finally {
      Object.assign(this, previous);
    }
  }

  commitReplacement(prepared) {
    patch(this.root, diff(this.vdom, prepared.next));
    this.component = prepared.component;
    this.props = prepared.props;
    this.hooks = prepared.hooks;
    this.vdom = prepared.next;
    this.mounted = true;
    this.rendered = true;
    // Keep processing after a failed cleanup, so another timer cannot leak.
    for (const effect of prepared.effects) {
      try { effect(); } catch (error) {
        if (this.onError) this.onError(error); else throw error;
      }
    }
  }

  update(props = this.props) {
    if (!this.mounted) throw new Error('Mount the component before updating.');
    const prepared = this.prepareReplacement(this.component, props, false);
    this.commitReplacement(prepared);
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    for (const slot of this.hooks) {
      try { slot.cleanup?.(); } catch (error) {
        if (this.onError) this.onError(error); else throw error;
      }
    }
    for (const child of this.root.childNodes) disposeDOM(child);
    this.root.replaceChildren();
  }
}
