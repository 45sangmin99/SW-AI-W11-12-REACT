import { loadRuntime, previewDocument } from './playground.js';
import { initialDocument } from './example.js';
import { historyShortcut } from './history.js';

const editor = document.querySelector('#editor');
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');
const patchButton = document.querySelector('#patch');
const autoApply = document.querySelector('#auto-apply');
const backButton = document.querySelector('#history-back');
const forwardButton = document.querySelector('#history-forward');
const historyPosition = document.querySelector('#history-position');
const domDebug = document.querySelector('#dom-debug');
let revision = 0;
let ready = false;
let debounce;
editor.value = initialDocument;

function sendDebug() {
  if (ready && domDebug) preview.contentWindow.postMessage({ playground: true, type: 'dom-debug', enabled: domDebug.checked }, '*');
}
domDebug?.addEventListener('change', sendDebug);

function sendSource() {
  clearTimeout(debounce);
  if (!ready) return;
  revision++;
  preview.contentWindow.postMessage({ playground: true, type: 'source', source: editor.value, revision }, '*');
}

function navigateHistory(offset) {
  clearTimeout(debounce);
  if (!ready) return;
  revision++;
  preview.contentWindow.postMessage({ playground: true, type: 'history', offset, revision }, '*');
}

backButton.addEventListener('click', () => navigateHistory(-1));
forwardButton.addEventListener('click', () => navigateHistory(1));
window.addEventListener('keydown', event => {
  const offset = historyShortcut(event);
  if (offset === null) return;
  event.preventDefault();
  navigateHistory(offset);
});

window.addEventListener('message', event => {
  if (event.source !== preview.contentWindow || !event.data?.playground) return;
  if (event.data.type === 'history-request') {
    navigateHistory(event.data.offset);
    return;
  }
  if (event.data.type === 'ready') {
    ready = true;
    patchButton.disabled = false;
    sendSource();
    sendDebug();
  } else if (event.data.revision === revision) {
    if (event.data.type === 'history') {
      const state = event.data.message;
      backButton.disabled = !state.canBack;
      forwardButton.disabled = !state.canForward;
      historyPosition.textContent = `${state.index + 1} / ${state.length}`;
      return;
    }
    status.textContent = event.data.type === 'error' ? String(event.data.message) : '';
    status.hidden = event.data.type !== 'error';
  }
});
editor.addEventListener('input', () => {
  clearTimeout(debounce);
  if (autoApply.checked) debounce = setTimeout(sendSource, 350);
});
patchButton.addEventListener('click', sendSource);
autoApply.addEventListener('change', () => {
  clearTimeout(debounce);
  if (autoApply.checked) sendSource();
});
editor.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(debounce);
    sendSource();
  }
});

try {
  const [runtime, controller] = await Promise.all([
    loadRuntime(new URL('./mini-react/index.js', import.meta.url).href),
    loadRuntime(new URL('./preview-controller.js', import.meta.url).href),
  ]);
  // This is the only iframe navigation. Every edit after boot is a message.
  preview.srcdoc = previewDocument(runtime, controller);
} catch (error) {
  status.textContent = error.message;
  status.hidden = false;
}
