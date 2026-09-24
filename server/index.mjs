import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { requestForModel } from "../shared/agent.mjs";
const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const editorOrigin = process.env.EDITOR_ORIGIN || "http://127.0.0.1:8080";
const ollamaOrigin = process.env.OLLAMA_ORIGIN || "http://192.168.69.28:11434";
const publicOrigin = process.env.PUBLIC_ORIGIN;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
let active = 0;
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://workspace");
  // The upstream logo links to /. Inside the frame, keep that navigation
  // in the editor rather than nesting another workspace.
  if (url.pathname === "/" && req.headers["sec-fetch-dest"] === "iframe") {
    res.writeHead(302, {
      Location: "/edit" + url.search,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  if (url.pathname === "/health") return json(res, 200, { status: "ok" });
  if (url.pathname === "/api/responses") {
    if (req.method !== "POST")
      return json(res, 405, { error: { message: "Use POST." } });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: { message: "Use application/json." } });
    if (
      req.headers["sec-fetch-site"] === "cross-site" ||
      (publicOrigin &&
        req.headers.origin &&
        req.headers.origin !== publicOrigin)
    )
      return json(res, 403, {
        error: { message: "Use the diagram workspace to send messages." },
      });
    if (active >= 4)
      return json(res, 429, {
        error: { message: "Gemma is busy. Try again shortly." },
      });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    res.on("close", () => controller.abort());
    active++;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          json(res, 413, {
            error: { message: "Conversation is too large. Start a new chat." },
          });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = requestForModel(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        return json(res, 400, { error: { message: e.message } });
      }
      const upstream = await fetch(`${ollamaOrigin}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!upstream.ok) {
        // Only read the model error, never log conversation content.
        let message =
          "Gemma could not process this request. Try again or start a new chat.";
        try {
          const error = await upstream.json();
          message = error.error?.message || error.error || message;
        } catch {}
        return json(res, 502, {
          error: {
            message:
              typeof message === "string"
                ? message.slice(0, 500)
                : "Model request failed.",
          },
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      for await (const chunk of upstream.body) {
        if (!res.write(chunk))
          await once(res, "drain", { signal: controller.signal });
      }
      res.end();
    } catch (e) {
      if (!res.headersSent)
        json(res, controller.signal.aborted ? 504 : 502, {
          error: {
            message: controller.signal.aborted
              ? "Gemma timed out. Try again."
              : "Cannot reach Gemma on the Spark. Try again shortly.",
          },
        });
      else res.destroy();
    } finally {
      clearTimeout(timeout);
      active--;
    }
    return;
  }
  if (url.pathname.startsWith("/api/"))
    return json(res, 404, { error: { message: "Unknown endpoint." } });
  if (url.pathname === "/" || url.pathname.startsWith("/workspace-assets/")) {
    if (!["GET", "HEAD"].includes(req.method))
      return json(res, 405, { error: { message: "Use GET." } });
    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 400, { error: { message: "Invalid path." } });
    }
    const path =
      url.pathname === "/"
        ? resolve(root, "index.html")
        : resolve(root, "." + decoded);
    if (!path.startsWith(root + "/"))
      return json(res, 404, { error: { message: "Not found." } });
    try {
      const data = await readFile(path);
      res.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control":
          url.pathname === "/"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "frame-ancestors 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      json(res, 404, { error: { message: "Not found." } });
    }
    return;
  }
  // Keep the pinned, unmodified editor at its native paths (including shared links).
  const target = new URL(editorOrigin);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent)
      json(res, 502, {
        error: { message: "Editor is starting. Reload in a moment." },
      });
    else res.destroy();
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});
if (process.argv[1] === fileURLToPath(import.meta.url))
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log("Mermaid workspace listening"),
  );
