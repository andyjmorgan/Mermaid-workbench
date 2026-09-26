# Mermaid workbench maintenance

Keep the upstream Mermaid Live Editor as the editor and renderer. This repository supplies the React workspace, the AI assistant, the server proxy, and a small upstream integration patch. Do not replace Monaco, Mermaid, themes, downloads, or the native share dialog with new implementations.

Read this guide before upgrading Mermaid or changing the iframe integration. The live app is https://mermaid.donkeywork.dev/. The GitHub repository is `git@github.com:andyjmorgan/Mermaid-workbench.git`.

## Source of truth

- `upstream.json` pins the upstream repository, tested revision, patch, and editor build arguments
- `patches/editor-workspace.patch` contains every change to upstream source
- `scripts/migrate-upstream.py` prepares isolated upgrades and records resolved patches
- `src/`, `shared/`, and `server/` contain our workspace and assistant implementation
- the separate `../mermaid-live-editor` checkout is a development convenience, not a required dependency or authoritative copy of the fixes
- Kubernetes manifests remain in `/mnt/lab/k3s/clusters/attic/applications/mermaid/`; they are not stored in this repository

The starting upstream revision is `e5e2ca41e96c93b30abd4a60c0f2be727019e8bc`. It used Mermaid 12.0.0. After an upgrade, `upstream.json` is authoritative. The renderer image is pinned separately in the lab's `renderer.yaml`.

## Required product behavior

The root URL opens Mermaid workspace. The top bar contains New, Duplicate, Share, and the assistant toggle. Its title is “Mermaid workspace”; the sidebar is “Mermaid assistant”. Keep the theme switcher on the canvas only. The assistant follows that theme.

Keep these upstream controls out of the workspace:

- the hamburger menu, Live Editor branding, GitHub links, docs and community links
- the inline AI gutter icon and AI popup on hovered code lines
- Contact sales, cloud Save diagram, Advanced Editor banners, and other upstream AI promotions
- the Kroki action and links to public mermaid.ink
- the History button, History pane, and the extra editor toolbar row
- an “Editor only” link or “Gemma on Spark” subtitle

Keep Code and Config tabs, sample diagrams, local PNG/SVG downloads, canvas controls, and the mobile Edit/View switch. Upstream local autosave still runs even though its History UI is hidden. The hidden native Share trigger opens the existing Share/embed dialog from the workspace header.

New opens upstream's default diagram in a new workspace tab. Duplicate copies the current source and configuration into a new workspace tab. Share and Markdown editing links point to `/#...`, not the bare iframe route. `/view` and `/embed` retain their native behavior.

The assistant still receives the diagram with every message. Do not display a “Diagram sent with this message” section in the chat. Keep the small attachment indicator and message/tool copy controls.

## Inventory of upstream changes

All paths in this table are relative to the upstream checkout.

| File | Required customization |
| --- | --- |
| `src/lib/components/DesktopEditor.svelte` | Gate both AI glyph rendering and AI popup opening with `env.isEnabledMermaidChartLinks`. Upstream previously ignored the setting here. |
| `src/lib/components/MainMenu.svelte` | Remove external and promotional entries; make remaining editing links use the workspace. The menu is no longer mounted in the edit page. Retain this cleanup if upstream reuses the component. |
| `src/lib/components/Navbar.svelte` | Remove hamburger, Live Editor branding and GitHub controls. The edit page no longer mounts this component; its cleanup prevents accidental reintroduction elsewhere. |
| `src/lib/components/Share.svelte` | Use “Mermaid workspace” branding and `urls.current.workspace`. Remove the inaccurate claim that diagram content never leaves the browser. |
| `src/lib/util/state.svelte.ts` | Add the serialized workspace URL and point the Markdown click-through link to the workspace root. |
| `src/routes/(app)/edit/+page.svelte` | Remove Navbar, History UI, sales/save controls, and Docs action. Preserve autosave and mobile Edit/View. Expose the New URL on the root element and mount Share behind a hidden trigger. |

The patch alone is not sufficient. `upstream.json` supplies these compile-time build arguments:

| Build argument | Value and purpose |
| --- | --- |
| `MERMAID_IS_ENABLED_MERMAID_CHART_LINKS` | `false`; disables supported promotions and the patched AI gutter controls |
| `MERMAID_HIDE_PRIVACY_POLICY` | `true`; hides the upstream policy popup, whose wording does not describe our backend |
| `MERMAID_RENDERER_URL` | `https://mermaid.donkeywork.dev/render`; image URLs and Markdown thumbnails use our renderer |
| `MERMAID_KROKI_RENDERER_URL` | empty; hides the Kroki action |

Changing runtime environment variables on nginx does not change these compiled settings. Rebuild the editor image.

## Wrapper contracts that upgrades must preserve

| Contract | Consumer and reason |
| --- | --- |
| `data-new-diagram-url={urls.current.new}` on the editor root | `src/App.tsx` reads the upstream default diagram URL for New. Do not depend on a removed navbar. |
| `[data-workspace-share] button` | The parent clicks this hidden native trigger; the Share dialog must portal into the visible iframe document. |
| `#editorMode[aria-checked="true"]` | The parent selects Edit on narrow screens after initialization. Upstream defaults to preview otherwise. |
| `[data-testid="theme-toggle-button"]` and the iframe document's `dark` class | Canvas theme control and the parent's MutationObserver keep both surfaces consistent. |
| `[data-testid="error-container"]` | Browser tool execution reads delayed Mermaid syntax errors and returns them to the model for correction. |
| `pako:` / `base64:` fragment format with string `code` and string `mermaid` fields | `src/editor.ts` captures and applies diagram state. Preserve other state fields when editing. |
| Native `hashchange` handling | AI tools update the existing iframe without replacing the editor. |
| `/edit`, `/view`, `/embed`, static asset paths and the upstream Dockerfile output | The Node server proxies native paths to the editor container. |

The scripts check a few source-level contracts as early tripwires. They do not prove runtime compatibility. If upstream changes a contract, adapt the patch, wrapper, migration checks and browser tests together.

### Navigation and browser fixes

`server/index.mjs` serves the workspace at `/`. A top-level browser `/edit` request redirects to `/`; iframe `/edit` requests still load the editor. Browser redirects preserve the fragment. The proxy marks iframe `/edit` HTML `Cache-Control: no-store` and `Vary: Sec-Fetch-Dest`. Without those headers, cached iframe HTML can bypass the workspace on a later top-level visit.

An iframe navigation to `/` redirects back to `/edit`, preventing nested workspaces. Keep that separate from top-level routing.

Duplicate must open an absolute workspace URL synchronously. Never open `about:blank` and rely on an awaited timer to navigate it: background tabs can suspend those timers. After opening, a snapshot captures any input still inside upstream's debounce. If the copy needs updating, the `?duplicate=1` URL forces a document navigation. A fragment-only change updates the parent URL but does not reset React's initial iframe source; this caused stale duplicates in Firefox. Preserve the existing navigation checks so a tab the user has left is not redirected.

### Layout fixes

At widths below 1024px, the assistant starts closed. At larger widths it occupies `clamp(320px,28vw,420px)`, leaving enough editor width to avoid Mermaid's 640px mobile breakpoint. The mobile assistant has a Back to editor control.

Do not cover the iframe with a loading overlay. Assistant readiness retries must leave the editor visible and usable. Test actual editor visibility, not just iframe presence or lack of horizontal overflow.

## Assistant implementation

- `shared/agent.mjs` owns the model (`gemma4:26b`), system prompt, tool schemas, config checks, and companion message format
- every user input contains `user_message`, `current_code`, and `current_config`; the latest snapshot is authoritative
- `edit_code` replaces the full Mermaid source; `edit_config` replaces the complete JSON configuration string
- `src/App.tsx` executes tools in the browser, returns results to the model, and limits each turn to six tool rounds
- `src/editor.ts` waits beyond upstream's 250ms hash debounce and requires a quiet input interval; never read shared cross-tab localStorage as current diagram context
- code/config fingerprints prevent overwriting manual edits made during inference; Undo has the same protection
- malformed current config blocks code replacement so upstream does not replace the diagram with its URL-error sample
- Mermaid delays error UI; the tool loop waits 3.2 seconds before returning render errors
- `src/responses.ts` and `shared/stream.mjs` consume OpenAI Responses SSE, including reasoning, text, function calls and outputs
- the server pins the model, tools, system prompt, `stream:true` and `store:false`; it ignores caller-supplied server-history IDs and does not log conversation bodies
- only per-tab `sessionStorage` holds conversation history, under `donkeywork-mermaid-chat-v1`; New chat clears it and reload preserves it
- Stop aborts generation; edits already applied remain; completed tool calls and their outputs stay paired in history
- the chat UI follows DonkeyWork-Agents themes, thinking sections, tool request/result fields, durations, status and copy buttons

Model syntax and theme names in the system prompt currently target Mermaid 12. Review them when upgrading Mermaid. Config guardrails and upstream rendering limits are intentional; do not remove them as part of a version update.

## Reapply the current base

Run from this repository. Python 3 and Git are required. Docker is required only with `--build`.

```sh
python3 scripts/migrate-upstream.py prepare \
  --output .upstream/current \
  --build mermaid-editor:workbench
```

The script clones upstream, checks out the exact pinned revision, checks and applies the patch, validates integration markers, and optionally builds the image. It does not push an image, change the pin, or deploy. `.upstream/` is excluded from Git and Docker build context.

For an offline preparation using an existing Git checkout:

```sh
python3 scripts/migrate-upstream.py prepare \
  --source ../mermaid-live-editor \
  --output .upstream/offline
```

Only committed Git objects are cloned. Dirty files in the source checkout are neither copied nor overwritten. Existing output directories are refused. Choose a new directory for each candidate.

For another hostname, add `--renderer-url https://your-host/render` alongside `--build`. This changes that image's build argument, not the maintained default in `upstream.json`.

## Upgrade to a new upstream revision

1. Choose an upstream tag or commit. Prefer a full commit SHA for a release. Check upstream release notes and changes to the contracts above.
2. Prepare a candidate without changing the live checkout or deployment:

   ```sh
   python3 scripts/migrate-upstream.py prepare \
     --ref <upstream-ref> \
     --output .upstream/upgrade-candidate
   ```

3. If direct application fails, inspect the retained checkout. A fresh candidate can try Git's three-way application:

   ```sh
   python3 scripts/migrate-upstream.py prepare \
     --ref <upstream-ref> \
     --output .upstream/upgrade-merge \
     --three-way
   ```

   Conflicts stop the script with a nonzero exit code. Resolve them against this guide. Stage resolved files with `git add`; do not commit the fixes in the candidate, because its HEAD must remain the upstream base. Do not discard unrelated work or accept the entire upstream side of a conflict blindly.
4. Build the candidate with the arguments in `upstream.json`. Run wrapper checks and the browser checks below. A successful patch application is not enough to deploy.
5. After verification, record the candidate:

   ```sh
   python3 scripts/migrate-upstream.py record \
     --checkout .upstream/upgrade-candidate
   ```

   Use the actual candidate directory if you resolved conflicts in another one. Record requires the migration marker, unchanged upstream HEAD, no unresolved conflicts, and no untracked files. Stage intended new files so they enter the patch. It generates a full-index patch, reapplies it in a temporary clean checkout, then updates the patch and revision pin. It does not commit or deploy.
6. Review `git diff -- upstream.json patches/editor-workspace.patch`, update this guide for changed contracts, and commit the upgrade in this repository. Push only after validation.

If a source-level check no longer fits upstream, update the checker with the corresponding integration changes. Do not weaken checks merely to make a failed upgrade green. The migration script leaves failed candidates available for inspection.

## Validation before release

Run the wrapper checks:

```sh
npm ci
npm test
npm run build
python3 tests/migration.py
```

Build the patched editor with its upstream Dockerfile. If working directly in the candidate, also run its relevant checks using the package manager/version declared there. Review upstream lint/type/test failures before release.

Run an isolated local workspace and editor. Set `EDITOR_ORIGIN` to that editor and `RENDERER_ORIGIN` to a reachable self-hosted Mermaid Ink instance. The wrapper defaults to port 3000; `PORT` overrides it. `OLLAMA_ORIGIN` defaults to the Spark at `http://192.168.69.28:11434`. `PUBLIC_ORIGIN` must match the tested workspace URL when enabled.

With Python Playwright and its Chromium/Firefox browsers installed:

```sh
WORKSPACE_URL=http://127.0.0.1:31473 python3 tests/browser.py
WORKSPACE_URL=http://127.0.0.1:31473 python3 tests/visibility.py
WORKSPACE_URL=http://127.0.0.1:31473 python3 tests/workspace-navigation.py
WORKSPACE_URL=http://127.0.0.1:31473 python3 tests/duplicate.py
```

These cover model/tool protocol with mocked responses, latest manual context, code and config edits, copy fields, reload history, Stop, conflict behavior, theme sync, mobile editor visibility, removed upstream UI, Share, New, Duplicate, local downloads, hosted image URLs, suspended source-tab timers and immediate-edit duplication. The current browser suite checks conflict protection but does not exercise every Undo branch; manually check Undo when changing mutation handling.

Also verify a real model turn when changing model/protocol behavior. Check PNG/SVG rendering with the chosen themes, old `/edit#...` links, `/view`, embed snippets, malformed config, and desktop/mobile screenshots. Never claim a user-visible issue is fixed solely because an iframe exists or a test passes in one browser.

## Deployment and image rendering

The lab's Mermaid deployment has two pods. Each contains nginx for the patched editor on 8080 and the Node workspace on 3000. The Service targets the workspace. Cloudflare routes the public hostname to that Service.

A separate pinned Mermaid Ink deployment renders `/render/img/...` and `/render/svg/...` through the workspace proxy. It runs under gVisor with no elevated capabilities and no outbound networking. Start it with `node src/index.js`, not `pnpm start`: the image's Corepack launcher attempted a registry download, which the network policy blocked. Its non-root user is UID 10042. It stores no diagrams. Local browser downloads do not need this service. No blob upload feature has been added.

The renderer currently has one replica because schedulable CPU was constrained. Workspace rollouts use `maxSurge: 0` and `maxUnavailable: 1` to keep one replica serving during upgrades. Verify current manifests rather than assuming capacity or image digests have stayed unchanged.

For lab changes, first read `/home/localuser/.agents/skills/lab-infrastructure/SKILL.md`, `/mnt/lab/k3s/AGENTS.md`, and the attic cluster guide. Use `kubectl --context=attic` explicitly. Update YAML before applying it; do not patch live resources or modify unrelated dirty lab files.

Build and push editor and wrapper images separately, pin their digests in the manifests, dry-run, apply, and wait for rollout. Build settings apply to the editor; server environment settings apply to the wrapper. Preserve previous digests for rollback. An upstream upgrade does not authorize rebuilding the renderer or changing the model automatically.
