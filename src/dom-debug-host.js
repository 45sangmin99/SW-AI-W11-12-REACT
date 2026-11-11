import { createDOMUpdateOverlay } from './mini-react/debug-overlay.js';

// Optional debug UI for applications using this framework (outside their root).
const document = window.document;
const root = document.getElementById('root');
if (root) {
  const host = document.createElement('div');
  host.setAttribute('data-mini-react-debug-control', '');
  host.style.cssText = 'all:initial;position:fixed;top:8px;right:8px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = 'label{display:flex;align-items:center;gap:5px;padding:6px 9px;border:1px solid #777;border-radius:4px;background:#171e23;color:#fff;font:12px sans-serif;cursor:pointer}';
  const label = document.createElement('label');
  label.title = '노랑: DOM 경계 · 초록: 최근 5개 브라우저 프레임의 Patch 변경';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  label.append(checkbox, 'DOM 갱신 표시');
  shadow.append(style, label);
  document.documentElement.append(host);
  const overlay = createDOMUpdateOverlay(root);
  const change = () => overlay.setEnabled(checkbox.checked);
  checkbox.addEventListener('change', change);
  window.addEventListener('pagehide', () => {
    overlay.dispose();
    checkbox.removeEventListener('change', change);
    host.remove();
  }, { once: true });
}
