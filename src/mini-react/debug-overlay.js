import { observePatches } from './patch.js';

export const DOM_DEBUG_COLORS = Object.freeze({ idle: '#facc15', updated: '#22c55e' });

// Browser-frame based debug rendering. No game clock or component state changes.
export function createDOMUpdateOverlay(root) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const host = document.createElement('div');
  host.setAttribute('data-mini-react-dom-overlay', '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{pointer-events:none!important}.box{position:absolute;box-sizing:border-box;border:1px solid;pointer-events:none;}';
  shadow.append(style);
  const boxes = new Map();
  let lastUpdated = new WeakMap();
  let enabled = false;
  let frame = 0;
  let request = null;
  let unsubscribe;

  function draw() {
    const live = new Set();
    const elements = [root, ...root.querySelectorAll('*')];
    for (const element of elements) {
      if (!element.isConnected || element.nodeType !== 1) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      live.add(element);
      let box = boxes.get(element);
      if (!box) {
        box = document.createElement('div');
        box.className = 'box';
        shadow.append(box);
        boxes.set(element, box);
      }
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      const until = lastUpdated.get(element);
      box.style.borderColor = until !== undefined && frame < until
        ? DOM_DEBUG_COLORS.updated : DOM_DEBUG_COLORS.idle;
    }
    for (const [element, box] of boxes) {
      if (!live.has(element)) { box.remove(); boxes.delete(element); }
    }
  }

  function tick() {
    if (!enabled) return;
    draw();
    frame++;
    request = window.requestAnimationFrame(tick);
  }

  function disable() {
    enabled = false;
    if (request !== null) window.cancelAnimationFrame(request);
    request = null;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const box of boxes.values()) box.remove();
    boxes.clear();
    lastUpdated = new WeakMap();
    host.remove();
  }

  return {
    setEnabled(value) {
      if (!value) { disable(); return; }
      if (enabled) return;
      enabled = true;
      frame = 0;
      document.documentElement.append(host);
      unsubscribe = observePatches(root, elements => {
        for (const element of elements) lastUpdated.set(element, frame + 5);
      });
      request = window.requestAnimationFrame(tick);
    },
    dispose: disable,
  };
}
