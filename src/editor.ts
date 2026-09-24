import { inflate, deflate } from "pako";
import type { EditorState } from "./types";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function decodeState(hash: string): EditorState {
  const raw = hash.replace(/^#/, "");
  const split = raw.indexOf(":");
  const type = split < 0 ? "base64" : raw.slice(0, split);
  const encoded = split < 0 ? raw : raw.slice(split + 1);
  if (!["base64", "pako"].includes(type))
    throw new Error("The editor URL format is not supported.");
  const bytes = Uint8Array.from(
    atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const state = JSON.parse(
    type === "pako"
      ? inflate(bytes, { to: "string" })
      : new TextDecoder().decode(bytes),
  );
  if (typeof state.code !== "string" || typeof state.mermaid !== "string")
    throw new Error("Waiting for the editor to finish loading.");
  return state;
}
export function encodeState(state: EditorState) {
  const bytes = deflate(new TextEncoder().encode(JSON.stringify(state)));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return (
    "pako:" +
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}
const activity = new WeakMap<Document, { lastInput: number }>();
function inputActivity(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Editor is not available.");
  let tracked = activity.get(doc);
  if (!tracked) {
    tracked = { lastInput: Date.now() };
    const state = tracked;
    for (const type of ["input", "keydown", "paste", "change", "click"])
      doc.addEventListener(
        type,
        () => {
          state.lastInput = Date.now();
        },
        true,
      );
    activity.set(doc, tracked);
  }
  return tracked;
}
export async function snapshot(
  frame: HTMLIFrameElement,
  signal?: AbortSignal,
): Promise<EditorState> {
  // Upstream debounces URL serialization by 250ms. Start after that window and
  // require a quiet hash before reading; do not read the shared cross-tab store.
  const tracked = inputActivity(frame);
  await sleep(400);
  let last = "";
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    signal?.throwIfAborted();
    const hash = frame.contentWindow?.location.hash || "";
    if (hash && hash === last && Date.now() - tracked.lastInput > 400) stable++;
    else stable = 0;
    if (stable >= 3) return decodeState(hash);
    last = hash;
    await sleep(75);
  }
  throw new Error("The editor is still updating. Wait a moment and try again.");
}
export async function applyState(
  frame: HTMLIFrameElement,
  state: EditorState,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!frame.contentWindow) throw new Error("Editor is not available.");
  const config = JSON.parse(state.mermaid);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(
      "The config must be a JSON object before loading this edit.",
    );
  // The upstream editor handles hashchange itself, including Monaco updates.
  frame.contentWindow.location.hash = encodeState(state);
  const result = await snapshot(frame, signal);
  if (result.code !== state.code)
    throw new Error("The editor did not accept the change.");
  return result;
}
export async function renderError(
  frame: HTMLIFrameElement,
  signal?: AbortSignal,
) {
  // The editor delays its syntax error UI for three seconds. Wait through that
  // debounce so a failed edit can be returned to Gemma for correction.
  await sleep(3200);
  signal?.throwIfAborted();
  const error = frame.contentDocument?.querySelector(
    '[data-testid="error-container"]',
  );
  return error?.textContent?.trim().slice(0, 4000) || null;
}
