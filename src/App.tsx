import { useEffect, useRef, useState, useCallback } from "react";
import {
  Bubbles,
  Plus,
  Copy,
  Share2,
  Send,
  Square,
  RotateCcw,
  PanelRightClose,
  PanelRightOpen,
  GitBranch,
  Loader2,
} from "lucide-react";
import { Button } from "./components/button";
import { Textarea } from "./components/textarea";
import { ChatTurn } from "./components/Chat";
import { snapshot, applyState, renderError, encodeState, decodeState } from "./editor";
import { respond } from "./responses";
import { companionMessage, editState, fingerprint } from "../shared/agent.mjs";
import type { Turn, ToolResult, EditorState, OutputItem } from "./types";
const KEY = "donkeywork-mermaid-chat-v1";
function load() {
  try {
    const data = JSON.parse(sessionStorage.getItem(KEY) || "{}");
    return {
      input: Array.isArray(data.input) ? data.input : [],
      turns: Array.isArray(data.turns)
        ? data.turns.map((t: Turn) =>
            t.status === "running"
              ? {
                  ...t,
                  status: "stopped",
                  note: "Interrupted by reload. Send a message to continue.",
                }
              : t,
          )
        : [],
    };
  } catch {
    return { input: [], turns: [] };
  }
}
const initial = load();
export default function App() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [turns, setTurns] = useState<Turn[]>(initial.turns);
  const turnsRef = useRef(turns);
  const input = useRef<unknown[]>(initial.input);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(() => window.innerWidth >= 1024);
  const [dark, setDark] = useState(false);
  const [notice, setNotice] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const observer = useRef<MutationObserver | null>(null);
  const [initialSrc] = useState(
    () => "/edit" + window.location.search + window.location.hash,
  );
  const persist = useCallback((next: Turn[]) => {
    turnsRef.current = next;
    setTurns(next);
    try {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({ input: input.current, turns: next }),
      );
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }, []);
  function patch(id: string, patch: Partial<Turn>) {
    persist(
      turnsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns, busy, open]);
  useEffect(
    () => () => {
      controller.current?.abort();
      observer.current?.disconnect();
    },
    [],
  );
  async function loaded() {
    observer.current?.disconnect();
    const doc = frame.current?.contentDocument;
    if (doc) {
      const sync = () =>
        setDark(doc.documentElement.classList.contains("dark"));
      sync();
      observer.current = new MutationObserver(sync);
      observer.current.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    // The iframe load event can precede Mermaid's asynchronous initialization.
    // Keep trying without covering the editor or requiring a page reload.
    while (frame.current?.isConnected) {
      try {
        await snapshot(frame.current);
        // Upstream defaults narrow screens to preview. Start in its Edit tab.
        const viewToggle = frame.current.contentDocument?.querySelector<HTMLButtonElement>(
          '#editorMode[aria-checked="true"]',
        );
        viewToggle?.click();
        setReady(true);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  async function send(message = draft) {
    if (lock.current || !message.trim() || !frame.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    follow.current = true;
    const abort = new AbortController();
    controller.current = abort;
    let assistantId = "";
    try {
      let expected = await snapshot(frame.current, abort.signal);
      input.current = [
        ...input.current,
        companionMessage(message.trim(), expected),
      ];
      const user: Turn = {
        id: crypto.randomUUID(),
        role: "user",
        text: message.trim(),
        snapshot: expected,
      };
      assistantId = crypto.randomUUID();
      persist([
        ...turnsRef.current,
        user,
        {
          id: assistantId,
          role: "assistant",
          items: [],
          tools: {},
          status: "running",
        },
      ]);
      setDraft("");
      const allItems: OutputItem[] = [];
      const toolResults: Record<string, ToolResult> = {};
      let usage = { input_tokens: 0, output_tokens: 0 };
      for (let round = 0; round < 6; round++) {
        abort.signal.throwIfAborted();
        const response = await respond(input.current, abort.signal, (items) =>
          patch(assistantId, { items: [...allItems, ...items] }),
        );
        allItems.push(...response.output);
        if (response.usage) {
          usage.input_tokens += response.usage.input_tokens;
          usage.output_tokens += response.usage.output_tokens;
        }
        patch(assistantId, { items: [...allItems], usage: { ...usage } });
        const calls = response.output.filter((i) => i.type === "function_call");
        if (!calls.length) {
          input.current.push(...response.output);
          patch(assistantId, { status: "complete" });
          break;
        }
        const outputs: unknown[] = [];
        let conflict = false;
        for (const call of calls) {
          const started = performance.now();
          let result: Record<string, unknown>;
          let before: EditorState | undefined;
          let after: EditorState | undefined;
          try {
            abort.signal.throwIfAborted();
            if (conflict)
              throw new Error(
                "The user changed the diagram. Stop and wait for a new request.",
              );
            const current = await snapshot(frame.current, abort.signal);
            if (fingerprint(current) !== fingerprint(expected)) {
              conflict = true;
              throw new Error(
                "The diagram changed while Gemma was working. Manual edits were preserved. Send a new request to continue.",
              );
            }
            const args = JSON.parse(call.arguments || "{}");
            const next = editState(call.name, args, current) as EditorState;
            before = current;
            after = await applyState(frame.current, next, abort.signal);
            expected = after;
            const error = await renderError(frame.current, abort.signal);
            result = {
              success: !error,
              applied: true,
              ...(error ? { error } : {}),
              current_code: after.code,
              current_config: after.mermaid,
            };
          } catch (e) {
            result = {
              success: false,
              error: abort.signal.aborted
                ? "Stopped by the user. Do not retry until asked."
                : (e as Error).message,
            };
          }
          const output = JSON.stringify(result);
          toolResults[call.call_id!] = {
            output,
            success: result.success === true,
            durationMs: performance.now() - started,
            before,
            after,
          };
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output,
          });
          patch(assistantId, { tools: { ...toolResults } });
        }
        // Persist only paired calls/results, so cancellation or reload never leaves
        // an orphan tool call in the next Responses request.
        input.current.push(...response.output, ...outputs);
        patch(assistantId, { tools: { ...toolResults } });
        if (conflict)
          throw new Error(
            "Your manual edits were preserved. Send a new message to apply changes to the updated diagram.",
          );
        abort.signal.throwIfAborted();
        if (round === 5)
          throw new Error(
            "Gemma reached the editing limit for this turn. Review the diagram and send another message to continue.",
          );
      }
    } catch (e) {
      const note = abort.signal.aborted
        ? "Stopped. Any edits already applied remain in the editor."
        : (e as Error).message;
      if (assistantId)
        patch(assistantId, {
          status: abort.signal.aborted ? "stopped" : "error",
          note,
        });
      else setNotice(note);
    } finally {
      setBusy(false);
      lock.current = false;
      controller.current = null;
    }
  }
  async function undo(result: ToolResult) {
    if (lock.current || !result.before || !result.after || !frame.current)
      return;
    lock.current = true;
    setBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const current = await snapshot(frame.current, abort.signal);
      if (fingerprint(current) !== fingerprint(result.after))
        throw new Error(
          "The diagram has changed since this edit. Undo would overwrite newer work.",
        );
      await applyState(frame.current, result.before, abort.signal);
      setNotice(
        "Edit undone. The next message will include the restored diagram.",
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
      controller.current = null;
    }
  }
  function newChat() {
    if (busy) return;
    input.current = [];
    persist([]);
    setNotice("");
  }
  function newDiagram() {
    const url = frame.current?.contentDocument
      ?.querySelector<HTMLElement>("[data-new-diagram-url]")?.dataset.newDiagramUrl;
    if (url) window.open("/" + url.slice(url.indexOf("#")), "_blank", "noopener,noreferrer");
  }
  async function duplicateDiagram() {
    if (!frame.current) return;
    // Navigate immediately: a backgrounded source tab can have its snapshot
    // timers throttled. The duplicate must never depend on them to leave blank.
    const initialHash = frame.current.contentWindow?.location.hash;
    if (!initialHash) return;
    const initialUrl = new URL("/" + initialHash, window.location.origin).href;
    const tab = window.open(initialUrl, "_blank");
    if (!tab) { setNotice("Allow popups to duplicate the diagram."); return; }
    tab.opener = null;
    try {
      const state = await snapshot(frame.current);
      const latestUrl = new URL("/#" + encodeState(state), window.location.origin).href;
      // Capture input still inside upstream's debounce without reloading an
      // unchanged copy or navigating a tab the user has already moved away from.
      const changed = JSON.stringify(state) !== JSON.stringify(decodeState(initialHash));
      if (!tab.closed && changed && [initialUrl, "about:blank"].includes(tab.location.href))
        tab.location.replace(latestUrl);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 text-accent" />
          <span className="hidden truncate text-sm font-semibold sm:inline">
            Mermaid workspace
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={!ready} onClick={newDiagram}>
            <Plus className="hidden sm:block" /> New
          </Button>
          <Button variant="ghost" size="sm" disabled={!ready} onClick={() => void duplicateDiagram()}>
            <Copy className="hidden sm:block" /> Duplicate
          </Button>
          <Button variant="ghost" size="sm" disabled={!ready} onClick={() => {
            frame.current?.contentDocument?.querySelector<HTMLButtonElement>("[data-workspace-share] button")?.click();
          }}>
            <Share2 className="hidden sm:block" /> Share
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="ai-panel"
          >
            {open ? <PanelRightClose /> : <PanelRightOpen />}
            {open ? <><span className="lg:hidden">Back to editor</span><span className="hidden lg:inline">Hide assistant</span></> : "Assistant"}
          </Button>
        </div>
      </header>
      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        <section
          className="relative min-w-0 flex-1"
          aria-label="Diagram editor"
        >
          <iframe
            ref={frame}
            title="Mermaid editor"
            src={initialSrc}
            onLoad={() => void loaded()}
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
          />
          {!ready && (
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center rounded-xl border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Connecting assistant to editor…
            </div>
          )}
        </section>
        {open && (
          <aside
            id="ai-panel"
            className="absolute inset-0 z-10 flex min-w-0 flex-col border-l border-border bg-card lg:relative lg:inset-auto lg:w-[clamp(320px,28vw,420px)] lg:shrink-0"
            aria-label="Mermaid assistant"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-accent/10 p-2 text-accent">
                  <Bubbles className="size-5" />
                </div>
                <div>
                  <h1 className="text-sm font-semibold">Mermaid assistant</h1>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New chat"
                title="Clear this tab’s conversation"
                disabled={busy || !turns.length}
                onClick={newChat}
              >
                <RotateCcw />
              </Button>
            </div>
            <div
              ref={scroll}
              className="chat-scroll min-h-0 flex-1 overflow-y-auto py-3"
              onScroll={() => {
                const el = scroll.current!;
                follow.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 90;
              }}
            >
              {!turns.length ? (
                <div className="space-y-5 px-5 pt-6">
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight">
                      What should this diagram show?
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      Describe a change, ask for a new diagram, or refine its
                      style. Gemma can edit the code and configuration beside
                      you.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {[
                      "Explain this diagram",
                      "Turn this into a sequence diagram",
                      "Use the forest theme",
                    ].map((s) => (
                      <button
                        type="button"
                        key={s}
                        onClick={() => setDraft(s)}
                        className="block w-full rounded-xl border border-border bg-background px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Each message includes your current code and config.
                    Conversation history stays in this browser tab.
                  </p>
                </div>
              ) : (
                turns.map((turn) => (
                  <ChatTurn
                    key={turn.id}
                    turn={turn}
                    onUndo={(r) => void undo(r)}
                    busy={busy}
                  />
                ))
              )}
            </div>
            <div className="shrink-0 border-t border-border p-4">
              {notice && (
                <p role="status" className="mb-3 text-xs text-muted-foreground">
                  {notice}
                </p>
              )}
              {storageWarning && (
                <p role="alert" className="mb-3 text-xs text-warning">
                  Browser storage is full or unavailable. This chat will not
                  survive a reload.
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
                className="space-y-3"
              >
                <Textarea
                  aria-label="Message to Gemma"
                  placeholder="Describe your diagram or a change…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  className="min-h-[92px] max-h-52 resize-y"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-muted-foreground">
                    {ready
                      ? "Current code & config included"
                      : "Waiting for editor"}
                  </span>
                  {busy ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => controller.current?.abort()}
                    >
                      <Square />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!ready || !draft.trim()}
                    >
                      <Send />
                      Send
                    </Button>
                  )}
                </div>
              </form>
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}
