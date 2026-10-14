import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer, request as proxyRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
const port = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3300);
const caCertPath = process.env.WEB_CA_CERT;
const tlsCertPath = process.env.WEB_TLS_CERT;
const tlsKeyPath = process.env.WEB_TLS_KEY;
const redirectHttpsPort = Number(process.env.WEB_REDIRECT_HTTPS_PORT ?? 0);
if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) throw new Error("HTTPS需要同时配置WEB_TLS_CERT和WEB_TLS_KEY");

const caFingerprint = caCertPath && existsSync(caCertPath)
  ? new X509Certificate(readFileSync(caCertPath)).fingerprint256
  : "";

const connectionGuide = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接抽检云台</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px 16px;background:#f1f5f3;color:#173a40;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:580px;margin:0 auto;padding:26px 22px;border:1px solid #dce8e3;border-radius:16px;background:#fff;box-shadow:0 12px 35px #123b4114}
h1{margin:0 0 8px;font-size:25px}h2{margin:24px 0 8px;font-size:17px}.success{padding:10px 12px;border-radius:8px;background:#e8f5ef;color:#286653}
p,li{margin:8px 0}ol{padding-left:23px}.button{display:block;margin:12px 0;padding:12px 16px;border-radius:8px;background:#16666b;color:white;text-align:center;text-decoration:none;font-weight:700}
.button.secondary{background:#e8f4ef;color:#195c60}.fingerprint{display:block;overflow-wrap:anywhere;padding:10px;border-radius:7px;background:#f3f6f5;font:12px/1.5 monospace}
small{color:#617b7e}code{overflow-wrap:anywhere}
</style></head><body><main>
<h1>手机连接抽检云台</h1><p class="success">此页已打开，说明手机能够连接到电脑的局域网服务。</p>
<h2>首次使用：安装局域网证书</h2><p>拍照定位需要受设备信任的 HTTPS。请先下载证书，在手机设置中安装并信任。</p>
<a class="button secondary" href="/lan-ca.crt" download>下载局域网证书</a>
<p><small>iPhone：安装描述文件后，在“设置 → 通用 → 关于本机 → 证书信任设置”开启完全信任。Android：在设置中搜索“安装 CA 证书”。</small></p>
<p><small>安装前核对证书 SHA-256 指纹：</small><span class="fingerprint">${caFingerprint}</span></p>
<h2>完成后打开系统</h2><a class="button" href="https://${host}:${redirectHttpsPort}/">打开 HTTPS 工作台</a>
<p><small>如果本页能打开而工作台提示连接不安全，请检查证书是否已在手机系统中信任；不要跳过证书警告。如果本页也打不开，请检查手机是否使用同一 Wi-Fi、是否连接访客网络，以及路由器是否开启设备隔离。</small></p>
</main></body></html>`;

const handleRequest = (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/lan-ca.crt" && caCertPath && existsSync(caCertPath)) {
    response.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": 'attachment; filename="lan-ca.crt"' });
    createReadStream(caCertPath).pipe(response);
    return;
  }
  if (!tlsCertPath && redirectHttpsPort) {
    if (pathname === "/" || pathname === "/connect") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(connectionGuide);
      return;
    }
    response.writeHead(308, { Location: `https://${host}:${redirectHttpsPort}${request.url ?? "/"}` });
    response.end();
    return;
  }
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
    const upstream = proxyRequest({
      hostname: "127.0.0.1",
      port: apiPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${apiPort}` },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ message: "API服务暂时不可用" })); }
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
    return;
  }
  const requested = normalize(join(root, decodeURIComponent(pathname)));
  const safePath = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : join(root, "index.html");
  response.writeHead(200, { "Content-Type": mimeTypes[extname(safePath)] ?? "application/octet-stream" });
  createReadStream(safePath).pipe(response);
};

const secure = Boolean(tlsCertPath);
const server = secure
  ? createHttpsServer({ cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }, handleRequest)
  : createHttpServer(handleRequest);
server.listen(port, host, () => {
  process.stdout.write(`管理后台：${secure ? "https" : "http"}://${host}:${port}/\n`);
});
