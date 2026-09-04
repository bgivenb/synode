import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoReport } from "./demo/scenario.js";

const root = resolve(fileURLToPath(new URL("../docs", import.meta.url)));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function secure(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

const server = createServer(async (request, response) => {
  secure(response);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (url.pathname === "/api/report") {
    sendJson(response, 200, await createDemoReport());
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const path = resolve(root, requested);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    sendJson(response, 400, { error: "invalid_path" });
    return;
  }

  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": extname(path) === ".html" ? "no-cache" : "public, max-age=300",
      "Content-Length": metadata.size,
      "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not_found" });
  }
});

server.listen(port, host, () => {
  console.log(`Synode control plane: http://${host}:${port}`);
});
