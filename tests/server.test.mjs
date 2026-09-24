import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
const seen = [];
const mock = http.createServer(async (req, res) => {
  if (req.url === "/edit") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" });
    res.end("editor");
    return;
  }
  if (req.url.startsWith("/svg/")) {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  seen.push(JSON.parse(raw));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
  );
});
mock.listen(0, "127.0.0.1");
await once(mock, "listening");
process.env.OLLAMA_ORIGIN = `http://127.0.0.1:${mock.address().port}`;
process.env.RENDERER_ORIGIN = process.env.OLLAMA_ORIGIN;
process.env.EDITOR_ORIGIN = process.env.OLLAMA_ORIGIN;
process.env.PUBLIC_ORIGIN = "https://mermaid.donkeywork.dev";
const { server } = await import("../server/index.mjs");
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections();
  mock.closeAllConnections();
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => mock.close(r)),
  ]);
});
const input = [
  {
    role: "user",
    content: JSON.stringify({
      user_message: "hello",
      current_code: "flowchart LR\n A-->B",
      current_config: "{}",
    }),
  },
];
test("proxy streams Responses while enforcing no server-side conversation state", async () => {
  const response = await fetch(origin + "/api/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: process.env.PUBLIC_ORIGIN,
    },
    body: JSON.stringify({
      input,
      store: true,
      previous_response_id: "stored",
      model: "other",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.match(await response.text(), /response.completed/);
  assert.equal(seen[0].store, false);
  assert.equal(seen[0].model, "gemma4:26b");
  assert.equal(seen[0].previous_response_id, undefined);
  assert.deepEqual(seen[0].input, input);
});
test("proxy rejects cross-origin calls and messages without current diagram context", async () => {
  for (const [headers, body, status] of [
    [
      { "Content-Type": "application/json", Origin: "https://other.example" },
      { input },
      403,
    ],
    [{ "Content-Type": "text/plain" }, { input }, 415],
    [
      { "Content-Type": "application/json" },
      { input: [{ role: "user", content: "missing context" }] },
      400,
    ],
  ]) {
    const r = await fetch(origin + "/api/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, status);
    await r.text();
  }
  assert.equal(seen.length, 1);
});
test("there is no history retrieval endpoint", async () => {
  const r = await fetch(origin + "/api/conversations");
  assert.equal(r.status, 404);
  await r.text();
});

test("upstream home links stay in the editor when navigated inside an iframe", async () => {
  const response = await fetch(origin + "/", {
    headers: { "Sec-Fetch-Dest": "iframe" },
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/edit");
  await response.text();
});

test("standalone editing links redirect to the workspace while preserving queries", async () => {
  const response = await fetch(origin + "/edit?gist=example", {
    headers: { "Sec-Fetch-Dest": "document" }, redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/?gist=example");
});
test("image URLs use the configured renderer without forwarding browser cookies", async () => {
  const response = await fetch(origin + "/render/svg/pako:example?bgColor=white", {
    headers: { Cookie: "private=example" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /image\/svg/);
  assert.deepEqual(await response.json(), { path: "/svg/pako:example?bgColor=white" });
  assert.equal((await fetch(origin + "/render/other")).status, 404);
});

test("iframe HTML cannot be cached as a standalone editor document", async () => {
  const response = await fetch(origin + "/edit", {
    headers: { "Sec-Fetch-Dest": "iframe" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("vary"), /Sec-Fetch-Dest/);
  assert.equal(await response.text(), "editor");
});
