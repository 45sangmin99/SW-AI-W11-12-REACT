// Inline the local module graph as data URLs so it can run in an isolated iframe.
export function moduleURL(source) {
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/javascript;base64,${btoa(binary)}`;
}

export async function loadRuntime(entry, fetchSource = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`모듈을 불러올 수 없습니다: ${url}`);
  return response.text();
}) {
  const cache = new Map();
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    const pending = (async () => {
      let source = await fetchSource(url);
      // The mini-react sources use static relative imports and re-exports.
      const imports = [...source.matchAll(/\b(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)];
      const replacements = new Map();
      for (const [, path] of imports) {
        replacements.set(path, await load(new URL(path, url).href));
      }
      source = source.replace(/(\b(?:from\s*|import\s*)['"])(\.\.?\/[^'"]+)(['"])/g,
        (_, prefix, path, suffix) => `${prefix}${replacements.get(path)}${suffix}`);
      return moduleURL(source);
    })();
    cache.set(url, pending);
    return pending;
  }
  return load(entry);
}

export function previewDocument(runtime, controller) {
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"></head><body>
<script id="__preview_boot" type="module">
import * as runtime from ${JSON.stringify(runtime)};
import { startPreview } from ${JSON.stringify(controller)};
startPreview(window, runtime);
</script></body></html>`;
}
