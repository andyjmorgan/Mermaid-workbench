# Mermaid workspace

An AI sidebar around Mermaid Live Editor at https://mermaid.donkeywork.dev. Top-level `/edit` links redirect to the workspace; the iframe still loads the native editor. Viewer and embed links still work.

## Behavior

- React parent page embeds the existing editor in a same-origin iframe. A small upstream patch removes promotional navigation and the gutter AI prompt, and makes New, Duplicate and shared editing links open the workspace.
- Reads the editor's `pako:` / `base64:` URL state after its 250ms debounce and a quiet input interval. This includes manual code and config edits, even when the diagram has a syntax error. It does not use the cross-tab `codeStore` for context.
- Every user message is a Responses input message whose JSON content contains `user_message`, `current_code`, and `current_config`. Earlier turns retain their original snapshots.
- Gemma (`gemma4:26b`) on the Spark receives the server-owned system prompt and `edit_code` / `edit_config` tools. It uses native OpenAI Responses streaming, including thinking, function calls, and function-call outputs.
- Tool edits run in the browser through Mermaid's existing hashchange handler. Returned render errors can be corrected in a subsequent tool round. A six-round bound prevents runaway editing. Manual edits made during inference are preserved; the user can then send a new request.
- Chat history is saved only in the browser tab's `sessionStorage`. It survives reloads and is cleared by New chat or closing the tab. The backend does not save conversations, accept `previous_response_id`, or log request/response bodies; it always sends `store:false` to Ollama. Requests and responses still pass through server memory for inference.
- Stop cancels the fetch and upstream generation. Changes already applied remain visible, with an Undo control that refuses to overwrite newer edits.
- The chat UI follows `DonkeyWork-Agents/src/frontend/packages/chat`: thinking sections, request/response tool cards, cyan user bubbles, usage details, and copy controls for messages, code blocks, tool requests/results, and individual fields. Button and textarea primitives plus theme tokens were reused from its UI package.

The backend pins the model and tools. It accepts only this application's Responses input contract, not an arbitrary model proxy. Code/config mutations are checked in the browser. Security configuration changes are not available as agent tools. The stock editor's rendering limits remain in effect.

## Source layout

- `shared/agent.mjs`: system prompt, tools, companion message schema, edit validation, model request policy.
- `shared/stream.mjs`: Responses SSE parsing and streamed item accumulation.
- `server/index.mjs`: stateless streaming proxy, static parent UI, reverse proxy to the original editor.
- `src/App.tsx`: frontend history and tool loop, iframe workspace.
- `src/editor.ts`: upstream URL-state integration and input-idle tracking.
- `src/components/Chat.tsx`: thinking/tool/text rendering and copy fields.

## Development

```sh
npm ci
npm run build
npm test
# Run the editor separately on 18473, then:
PORT=31473 EDITOR_ORIGIN=http://127.0.0.1:18473 npm start
```

The default Spark endpoint is `http://192.168.69.28:11434`. Override `OLLAMA_ORIGIN` for development. `PUBLIC_ORIGIN=https://mermaid.donkeywork.dev` enables the production same-origin request check. The browser always calls `/api/responses` on the workspace origin.

For Vite development, use `PORT=3100` for the Node process and `npm run dev` in another terminal.

Browser checks require Python Playwright with Chromium and a running app:

```sh
WORKSPACE_URL=http://127.0.0.1:31473 python tests/browser.py
```

Those checks use deterministic Responses streams. A separate live smoke test verified Gemma receives manually edited code, executes both tools, changes the actual diagram/theme, and responds after tool results.

## Deployment

Manifests live in `/mnt/lab/k3s/clusters/attic/applications/mermaid/`. Each pod runs the existing nginx editor on 8080 and this stateless Node wrapper on 3000. The Service's target port selects the wrapper; the Cloudflare hostname and tunnel rule stay unchanged. No database, PVC, or model API credentials are required.

```sh
docker build -t 192.168.0.140:5555/donkeywork/mermaid-workspace:<release> .
docker push 192.168.0.140:5555/donkeywork/mermaid-workspace:<release>
# Pin the pushed digest in deployment.yaml, dry-run, apply, and check rollout.
```

To return to the editor-only site, change the Service targetPort to `http` (8080) in service.yaml and apply it. Keep the wrapper container or remove it in the deployment manifest. No saved server state needs migration.

## Upstream patch and image rendering

`patches/editor-workspace.patch` applies to upstream commit `e5e2ca41e96c93b30abd4a60c0f2be727019e8bc` with `git apply`. Keep this patch when updating the editor. The Mermaid engine, Monaco editor, themes, history and exports remain upstream implementations.

Build the patched editor with:

```sh
docker build --build-arg MERMAID_IS_ENABLED_MERMAID_CHART_LINKS=false \
  --build-arg MERMAID_HIDE_PRIVACY_POLICY=true \
  --build-arg MERMAID_RENDERER_URL=https://mermaid.donkeywork.dev/render \
  --build-arg MERMAID_KROKI_RENDERER_URL= \
  -t 192.168.0.140:5555/donkeywork/mermaid:<release> .
```

PNG/SVG URL exports and Markdown thumbnails use `/render/img/...` and `/render/svg/...`. Node forwards these to `RENDERER_ORIGIN` (default `http://mermaid-renderer:3000`). The dedicated pinned Mermaid Ink deployment uses gVisor, runs without elevated capabilities, and has no outbound network access. It stores no diagrams or conversations. Local browser downloads still work without the renderer.
