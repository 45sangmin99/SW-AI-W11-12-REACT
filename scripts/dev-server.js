import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/logistics.html", ["logistics.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/src/component.js", ["src/component.js", "text/javascript; charset=utf-8"]],
  ["/src/diff.js", ["src/diff.js", "text/javascript; charset=utf-8"]],
  ["/src/history.js", ["src/history.js", "text/javascript; charset=utf-8"]],
  ["/src/logistics.js", ["src/logistics.js", "text/javascript; charset=utf-8"]],
  ["/src/main.js", ["src/main.js", "text/javascript; charset=utf-8"]],
  ["/src/patch.js", ["src/patch.js", "text/javascript; charset=utf-8"]],
  ["/src/patch-summary.js", ["src/patch-summary.js", "text/javascript; charset=utf-8"]],
  ["/src/render.js", ["src/render.js", "text/javascript; charset=utf-8"]],
  ["/src/todos.js", ["src/todos.js", "text/javascript; charset=utf-8"]],
  ["/src/vdom.js", ["src/vdom.js", "text/javascript; charset=utf-8"]],
]);

export function createDevServer() {
  return createServer(async (request, response) => {
    const file = files.get(new URL(request.url, "http://localhost").pathname);

    if (!file) {
      response.writeHead(404).end("Not Found");
      return;
    }

    try {
      response.writeHead(200, { "Content-Type": file[1] });
      response.end(await readFile(new URL(file[0], root)));
    } catch {
      response.writeHead(500).end("Internal Server Error");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDevServer().listen(3000, "127.0.0.1", () => {
    console.log("Mini React: http://127.0.0.1:3000");
  });
}
