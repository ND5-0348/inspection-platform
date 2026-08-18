import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..", "apps", "admin-web", "dist");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const host = process.env.WEB_HOST ?? "127.0.0.1";

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const requested = normalize(join(root, decodeURIComponent(pathname)));
  const safePath = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : join(root, "index.html");
  response.writeHead(200, { "Content-Type": mimeTypes[extname(safePath)] ?? "application/octet-stream" });
  createReadStream(safePath).pipe(response);
}).listen(5173, host, () => {
  process.stdout.write(`管理后台：http://${host}:5173/\n`);
});
