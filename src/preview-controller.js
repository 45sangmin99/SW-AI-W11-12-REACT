import { cloneData, createHistory, historyShortcut } from './history.js';

// Supported refresh boundary: inline scripts and stable, id-based component roots.
// User scripts run in the iframe; the parent page never evaluates editor code.
function compileScripts(document, WindowFunction) {
  const sources = [];
  for (const script of document.querySelectorAll('script')) {
    if (script.type && script.type !== 'module' && script.type !== 'text/javascript') continue;
    if (script.src) throw new Error('미리보기에서는 외부 script 대신 인라인 스크립트를 사용해 주세요.');
    const source = script.textContent.replace(
      /\bimport\s+(\{[^}]*\}|\*\s+as\s+\w+)\s+from\s*(['"])mini-react\2\s*;?/g,
      (_, names) => names.startsWith('{')
        ? 'const ' + names.replace(/\bas\b/g, ':') + ' = miniReact;'
        : 'const ' + names.replace(/\*\s+as\s+/, '') + ' = miniReact;',
    );
    sources.push(source);
    script.remove();
  }
  try {
    return new WindowFunction('document', 'window', 'miniReact',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      '"use strict";\n' + sources.join('\n;\n'));
  } catch (error) {
    throw new Error('코드를 적용하지 않았습니다: ' + error.message);
  }
}

function nodePath(node, document) {
  const path = [];
  while (node && node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return node === document ? path : null;
}

// Track script-owned timers/listeners so replacing a script cannot accumulate them.
// DOM queries return forwarding references: callbacks use the live document after commit.
function scriptScope(window, staged) {
  let active = false;
  let disposed = false;
  const live = window.document;
  const proxies = new WeakMap();
  const originals = new WeakMap();
  const resources = new Set();
  let timerId = 0;
  const timers = new Map();
  const unwrap = value => originals.get(value) ?? value;
  const resolve = node => {
    if (!active) return node;
    if (node === staged) return live;
    if (node.id) return live.getElementById(node.id) ?? node;
    const path = nodePath(node, staged);
    return path?.reduce((parent, index) => parent?.childNodes[index], live) ?? node;
  };
  function resource(start) {
    const item = { start, cleanup: null };
    resources.add(item);
    if (active && !disposed) item.cleanup = start();
    return item;
  }
  function listen(target, type, callback, options) {
    return resource(() => {
      const node = target();
      node.addEventListener(type, callback, options);
      return () => node.removeEventListener(type, callback, options);
    });
  }
  function removeListener(target, type, callback, options) {
    // Match by registration identity, including the capture flag.
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    for (const item of resources) {
      if (item.target === target && item.type === type && item.callback === callback && item.capture === capture) {
        item.cleanup?.();
        resources.delete(item);
      }
    }
  }
  function addListener(target, type, callback, options) {
    const item = listen(target, type, callback, options);
    Object.assign(item, { target, type, callback, capture: typeof options === 'boolean' ? options : !!options?.capture });
  }
  function wrap(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.nodeType === undefined) {
      if (value instanceof window.NodeList || value instanceof window.HTMLCollection) return Array.from(value, wrap);
      return value;
    }
    if (proxies.has(value)) return proxies.get(value);
    const target = () => resolve(value);
    const proxy = new Proxy(value, {
      get(_, key) {
        if (key === 'addEventListener') return (type, callback, options) => addListener(target, type, callback, options);
        if (key === 'removeEventListener') return (type, callback, options) => removeListener(target, type, callback, options);
        const node = target();
        const member = Reflect.get(node, key, node);
        return typeof member === 'function'
          ? (...args) => wrap(member.apply(node, args.map(unwrap))) : wrap(member);
      },
      set(_, key, next) {
        if (typeof key === 'string' && /^on/.test(key)) {
          resource(() => {
            const node = target();
            const previous = node[key];
            node[key] = next;
            return () => { if (node[key] === next) node[key] = previous; };
          });
        } else {
          const node = target();
          Reflect.set(node, key, unwrap(next), node);
        }
        return true;
      },
    });
    proxies.set(value, proxy);
    originals.set(proxy, value);
    return proxy;
  }
  function startTimer(repeat, callback, delay, args) {
    const id = ++timerId;
    const item = resource(() => {
      const actual = (repeat ? window.setInterval : window.setTimeout)(() => {
        if (!repeat) { timers.delete(id); resources.delete(item); }
        if (!disposed) callback(...args);
      }, delay);
      return () => (repeat ? window.clearInterval : window.clearTimeout)(actual);
    });
    timers.set(id, item);
    return id;
  }
  function clearTimer(id) {
    const item = timers.get(id);
    item?.cleanup?.();
    if (item) resources.delete(item);
    timers.delete(id);
  }
  const methods = {
    setInterval: (callback, delay, ...args) => startTimer(true, callback, delay, args),
    setTimeout: (callback, delay, ...args) => startTimer(false, callback, delay, args),
    clearInterval: clearTimer,
    clearTimeout: clearTimer,
  };
  const windowTarget = () => window;
  const windowProxy = new Proxy(window, {
    get(target, key) {
      if (key === 'document') return wrap(staged);
      if (key in methods) return methods[key];
      if (key === 'addEventListener') return (type, callback, options) => addListener(windowTarget, type, callback, options);
      if (key === 'removeEventListener') return (type, callback, options) => removeListener(windowTarget, type, callback, options);
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' && !/^[A-Z]/.test(String(key)) ? member.bind(target) : member;
    },
  });
  return {
    document: wrap(staged), window: windowProxy, methods,
    activate() {
      active = true;
      for (const item of resources) item.cleanup = item.start();
    },
    dispose() {
      disposed = true;
      for (const item of resources) {
        try { item.cleanup?.(); } catch { /* Continue clearing other resources. */ }
      }
      resources.clear();
      timers.clear();
    },
  };
}

export function createPreviewController(window, runtime, report = () => {}) {
  const document = window.document;
  const instances = new Map();
  const history = createHistory();
  let previousScope;
  let disposed = false;

  function apply(source, restoring = null) {
    if (disposed) return false;
    let scope;
    try {
      const staged = new window.DOMParser().parseFromString(source, 'text/html');
      const execute = compileScripts(staged, window.Function);
      const mounts = new Map();
      scope = scriptScope(window, staged);
      class RefreshableComponent extends runtime.FunctionComponent {
        mount() {
          const id = this.root?.id;
          if (!id || staged.getElementById(id) === null) {
            throw new Error('컴포넌트의 컨테이너에는 고유한 id가 필요합니다.');
          }
          if (mounts.has(id)) throw new Error('같은 컨테이너에 두 번 mount할 수 없습니다: ' + id);
          mounts.set(id, this);
          return this;
        }
      }
      const api = { ...runtime, FunctionComponent: RefreshableComponent };
      execute(scope.document, scope.window, api, ...['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'].map(key => scope.methods[key]));
      if (restoring) {
        runtime.patch(staged.head, runtime.diff(runtime.domToVDOM(staged.head), restoring.head));
        runtime.patch(staged.body, runtime.diff(runtime.domToVDOM(staged.body), restoring.body));
      }

      for (const [id, instance] of instances) {
        const nextRoot = staged.getElementById(id);
        if (restoring && !mounts.has(id)) continue;
        if (!mounts.has(id) || !nextRoot || nextRoot.localName !== instance.root.localName
          || JSON.stringify(nodePath(nextRoot, staged.body)) !== JSON.stringify(nodePath(instance.root, document.body))) {
          throw new Error('기존 컴포넌트의 컨테이너 id·태그·위치를 유지해 주세요: ' + id);
        }
      }
      const prepared = [];
      for (const [id, candidate] of mounts) {
        const saved = restoring?.components.get(id);
        const instance = instances.get(id) ?? saved?.instance ?? candidate;
        const liveHooks = instance.hooks;
        if (saved) instance.hooks = saved.hooks.map((slot, index) => ({
          ...slot,
          value: cloneData(slot.value),
          deps: slot.deps?.slice(),
          cleanup: instance.mounted && liveHooks[index]?.kind === 'effect' ? liveHooks[index].cleanup : undefined,
        }));
        try {
          prepared.push({ id, instance, render: instance.prepareReplacement(candidate.component, candidate.props) });
        } finally {
          instance.hooks = liveHooks;
        }
      }

      if (restoring) {
        for (const [id, instance] of instances) {
          if (!mounts.has(id)) { instance.unmount(); instances.delete(id); }
        }
      }

      // Component roots are opaque to document edits: preserve their real children.
      const previousBody = runtime.domToVDOM(document.body);
      const nextBody = runtime.domToVDOM(staged.body);
      function preserve(node) {
        const instance = instances.get(node.props?.id);
        if (instance) node.children = runtime.domToVDOM(instance.root).children;
        else node.children?.forEach(preserve);
      }
      preserve(nextBody);
      const headChanges = runtime.diff(runtime.domToVDOM(document.head), runtime.domToVDOM(staged.head));
      const bodyChanges = runtime.diff(previousBody, nextBody);
      // No user-code evaluation or hook validation remains beyond this point.
      runtime.patch(document.head, headChanges);
      runtime.patch(document.body, bodyChanges);
      previousScope?.dispose();
      scope.activate();
      previousScope = scope;
      const effectErrors = [];
      for (const { id, instance, render } of prepared) {
        instance.root = document.getElementById(id);
        if (!instances.has(id)) {
          instance.vdom = { type: '#fragment', props: {}, children: runtime.domToVDOM(instance.root).children };
        }
        instance.onError = error => {
          effectErrors.push(error.message);
          report('error', error.message);
        };
        instance.commitReplacement(render);
        instances.set(id, instance);
      }
      if (effectErrors.length) report('error', effectErrors.join('\n'));
      else {
        if (!restoring) {
          const head = runtime.domToVDOM(document.head);
          const body = runtime.domToVDOM(document.body);
          const components = new Map([...instances].map(([id, instance]) => [id, {
            instance,
            hooks: instance.hooks.map(slot => ({ ...slot, value: cloneData(slot.value), deps: slot.deps?.slice(), cleanup: undefined })),
          }]));
          history.record({ source, head, body, components }, JSON.stringify({ head, body }));
        }
        report('applied', '');
        report('history', history.state);
      }
      return true;
    } catch (error) {
      scope?.dispose();
      report('error', error.message + ' 이전 화면과 상태를 유지합니다.');
      return false;
    }
  }

  return {
    apply,
    getHistory: () => history.state,
    navigate(offset) {
      if (disposed || offset !== -1 && offset !== 1) return false;
      const snapshot = history.target(offset);
      if (!snapshot || !apply(snapshot.source, snapshot)) return false;
      history.move(offset);
      report('history', history.state);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const instance of instances.values()) instance.unmount();
      previousScope?.dispose();
      instances.clear();
    },
  };
}

export function startPreview(window, runtime) {
  window.document.getElementById('__preview_boot')?.remove();
  const send = (type, message, revision = currentRevision) => window.parent.postMessage({ playground: true, type, message, revision }, '*');
  let currentRevision = 0;
  const controller = createPreviewController(window, runtime, send);
  const overlay = runtime.createDOMUpdateOverlay(window.document.body);
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data?.playground) return;
    if (event.data.type === 'dom-debug') {
      overlay.setEnabled(!!event.data.enabled);
      return;
    }
    currentRevision = event.data.revision;
    if (event.data.type === 'source') controller.apply(event.data.source);
    if (event.data.type === 'history') controller.navigate(event.data.offset);
  });
  window.addEventListener('keydown', event => {
    const offset = historyShortcut(event);
    if (offset === null) return;
    event.preventDefault();
    window.parent.postMessage({ playground: true, type: 'history-request', offset }, '*');
  });
  window.addEventListener('error', event => send('error', event.message));
  window.addEventListener('unhandledrejection', event => send('error', String(event.reason?.message ?? event.reason)));
  window.addEventListener('pagehide', () => { overlay.dispose(); controller.dispose(); }, { once: true });
  send('ready', '');
}
