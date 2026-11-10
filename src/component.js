import { diff } from "./diff.js";
import { patch } from "./patch.js";
import { vdomToDom } from "./render.js";

let currentComponent = null;

function sameDependencies(previous, next) {
  return previous !== undefined
    && next !== undefined
    && previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));
}

export function useState(initialValue) {
  if (!currentComponent) {
    throw new Error("useState must be called while rendering a FunctionComponent.");
  }

  const component = currentComponent;
  const index = component.hookIndex++;
  if (!(index in component.hooks)) component.hooks[index] = initialValue;

  const setState = (nextValue) => {
    const previousValue = component.hooks[index];
    component.hooks[index] = typeof nextValue === "function"
      ? nextValue(previousValue)
      : nextValue;
    component.update();
  };

  return [component.hooks[index], setState];
}

export function useEffect(effect, dependencies) {
  if (!currentComponent) {
    throw new Error("useEffect must be called while rendering a FunctionComponent.");
  }
  if (typeof effect !== "function") {
    throw new TypeError("useEffect requires a function.");
  }
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    throw new TypeError("useEffect dependencies must be an array or undefined.");
  }

  const component = currentComponent;
  const index = component.hookIndex++;
  const previous = component.hooks[index];
  const changed = previous?.type !== "effect"
    || !sameDependencies(previous.dependencies, dependencies);

  component.hooks[index] = {
    type: "effect",
    effect,
    dependencies,
    cleanup: previous?.type === "effect" ? previous.cleanup : undefined,
  };
  if (changed) component.pendingEffects.push(index);
}

export function useMemo(factory, dependencies) {
  if (!currentComponent) {
    throw new Error("useMemo must be called while rendering a FunctionComponent.");
  }
  if (typeof factory !== "function") {
    throw new TypeError("useMemo requires a function.");
  }
  if (dependencies !== undefined && !Array.isArray(dependencies)) {
    throw new TypeError("useMemo dependencies must be an array or undefined.");
  }

  const component = currentComponent;
  const index = component.hookIndex++;
  const previous = component.hooks[index];
  if (previous?.type === "memo"
    && sameDependencies(previous.dependencies, dependencies)) {
    return previous.value;
  }

  const value = factory();
  component.hooks[index] = { type: "memo", value, dependencies };
  return value;
}

export class FunctionComponent {
  constructor(component, props, container, documentRef = globalThis.document) {
    if (typeof component !== "function") {
      throw new TypeError("FunctionComponent requires a function.");
    }

    this.component = component;
    this.props = props;
    this.container = container;
    this.document = documentRef;
    this.hooks = [];
    this.hookIndex = 0;
    this.vdom = null;
    this.root = null;
    this.lastPatches = [];
    this.pendingEffects = [];
    this.mounted = false;
  }

  render() {
    const previousComponent = currentComponent;
    currentComponent = this;
    this.hookIndex = 0;
    this.pendingEffects = [];

    try {
      return this.component(this.props);
    } finally {
      currentComponent = previousComponent;
    }
  }

  runEffects() {
    const pendingEffects = this.pendingEffects;
    this.pendingEffects = [];

    for (const index of pendingEffects) {
      const hook = this.hooks[index];
      hook.cleanup?.();
      const cleanup = hook.effect();
      hook.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }

  mount() {
    if (this.mounted) {
      throw new Error("FunctionComponent is already mounted.");
    }

    this.vdom = this.render();
    this.root = this.vdom == null ? null : vdomToDom(this.vdom, this.document);
    this.container.replaceChildren(...(this.root ? [this.root] : []));
    this.mounted = true;
    this.runEffects();
    return this.root;
  }

  update(nextProps = this.props) {
    if (!this.mounted) {
      throw new Error("FunctionComponent must be mounted before update().");
    }

    this.props = nextProps;
    const nextVdom = this.render();
    const patches = diff(this.vdom, nextVdom);

    this.root = patch(this.root, patches, this.document);
    if (this.root?.parentNode !== this.container) {
      this.container.replaceChildren(...(this.root ? [this.root] : []));
    }

    this.vdom = nextVdom;
    this.lastPatches = patches;
    this.runEffects();
    return patches;
  }

  unmount() {
    if (!this.mounted) return;

    for (const hook of this.hooks) {
      if (hook?.type === "effect") hook.cleanup?.();
    }
    this.root?.remove();
    this.hooks = [];
    this.pendingEffects = [];
    this.vdom = null;
    this.root = null;
    this.mounted = false;
  }
}
