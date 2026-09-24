import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BrainCircuit,
  ChevronRight,
  Check,
  Copy,
  Wrench,
  CircleX,
  Clock,
  Undo2,
  Loader2,
} from "lucide-react";
import type { Turn, OutputItem, ToolResult } from "../types";
import { cn } from "../lib/utils";
import { Button } from "./button";
export function CopyButton({
  text,
  label = "Copy message",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={
        failed ? "Clipboard unavailable; select and copy the text." : label
      }
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setFailed(true);
        }
      }}
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : failed ? (
        <CircleX className="size-3.5 text-destructive" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
function Field({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="min-w-0 border-t border-border py-2 first:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        <CopyButton text={text ?? ""} label={`Copy ${label}`} />
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  );
}
export function Fields({ label, raw }: { label: string; raw: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <CopyButton text={raw} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (
        Object.entries(parsed).map(([key, value]) => (
          <Field key={key} label={key} value={value} />
        ))
      ) : (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
          {raw}
        </pre>
      )}
    </div>
  );
}
function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-prose prose prose-sm max-w-none text-foreground dark:prose-invert prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-code:text-accent">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            const child = children as { props?: { children?: string } };
            return (
              <div className="relative">
                <div className="absolute right-1 top-1">
                  <CopyButton
                    text={String(child?.props?.children ?? "")}
                    label="Copy code block"
                  />
                </div>
                <pre className="pr-10">{children}</pre>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
function Detail({
  title,
  icon,
  children,
  tone = "",
  open = false,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  tone?: string;
  open?: boolean;
}) {
  return (
    <details
      open={open || undefined}
      className={cn(
        "group my-2 overflow-hidden rounded-lg border border-border bg-muted/30",
        tone,
      )}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-muted/50">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {icon}
        <span>{title}</span>
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}
function ToolCard({
  item,
  result,
  running,
  onUndo,
}: {
  item: OutputItem;
  result?: ToolResult;
  running: boolean;
  onUndo: (r: ToolResult) => void;
}) {
  const title =
    item.name === "edit_code"
      ? "Edit code"
      : item.name === "edit_config"
        ? "Edit config"
        : item.name || "Tool call";
  return (
    <details
      className={cn(
        "group my-2 overflow-hidden rounded-lg border",
        result
          ? result.success
            ? "border-success/20 bg-success/5"
            : "border-destructive/20 bg-destructive/5"
          : "border-thinking/20 bg-thinking/5",
      )}
      data-testid="tool-card"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        {result ? (
          result.success ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <CircleX className="size-3.5 text-destructive" />
          )
        ) : (
          <Wrench className="size-3.5 text-thinking" />
        )}
        <span className="font-mono">{title}</span>
        {!result && running && (
          <Loader2 className="size-3 animate-spin text-thinking" />
        )}
        {result && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Clock className="size-3" />
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </summary>
      <div className="divide-y divide-border border-t border-border">
        <Fields label="Request" raw={item.arguments || ""} />
        {result && <Fields label="Response" raw={result.output} />}
      </div>
      {result?.before && result.after && (
        <div className="border-t border-border px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            onClick={() => onUndo(result)}
          >
            <Undo2 />
            Undo this edit
          </Button>
        </div>
      )}
    </details>
  );
}
export function ChatTurn({
  turn,
  onUndo,
  busy,
}: {
  turn: Turn;
  onUndo: (r: ToolResult) => void;
  busy: boolean;
}) {
  if (turn.role === "user")
    return (
      <article className="flex flex-col items-end px-5 py-3">
        <div className="max-w-[90%] rounded-2xl rounded-br-md bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-sm text-white shadow-sm">
          <span className="whitespace-pre-wrap break-words">{turn.text}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            Code & config attached
          </span>
          <CopyButton text={turn.text || ""} />
        </div>
        {turn.snapshot && (
          <div className="w-full">
            <Detail
              title="Diagram sent with this message"
              icon={<Wrench className="size-3.5" />}
            >
              <Fields
                label="Context"
                raw={JSON.stringify({
                  code: turn.snapshot.code,
                  config: turn.snapshot.mermaid,
                })}
              />
            </Detail>
          </div>
        )}
      </article>
    );
  const text = (turn.items || [])
    .filter((i) => i.type === "message")
    .flatMap((i) => i.content || [])
    .map((c) => c.text || "")
    .join("\n\n");
  return (
    <article className="min-w-0 px-5 py-3" aria-label="Assistant response">
      {turn.items?.map((item, i) =>
        item.type === "reasoning" ? (
          <Detail
            key={item.id || i}
            title="Thinking"
            icon={<BrainCircuit className="size-3.5" />}
            tone="border-thinking/20 bg-thinking/5 text-thinking"
            open={turn.status === "running"}
          >
            <div className="px-3 py-2.5">
              <div className="flex justify-end">
                <CopyButton
                  label="Copy thinking"
                  text={(item.summary || []).map((s) => s.text).join("\n")}
                />
              </div>
              <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-muted-foreground">
                {(item.summary || []).map((s) => s.text).join("\n")}
              </p>
            </div>
          </Detail>
        ) : item.type === "function_call" ? (
          <ToolCard
            key={item.id || item.call_id || i}
            item={item}
            result={turn.tools?.[item.call_id || ""]}
            running={busy}
            onUndo={onUndo}
          />
        ) : item.type === "message" ? (
          <Markdown
            key={item.id || i}
            text={(item.content || []).map((c) => c.text || "").join("")}
          />
        ) : null,
      )}
      {turn.status === "running" && (
        <div
          className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-3 animate-spin" />
          Gemma is working…
        </div>
      )}
      {turn.note && (
        <p
          className={cn(
            "mt-2 text-xs",
            turn.status === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          role={turn.status === "error" ? "alert" : undefined}
        >
          {turn.note}
        </p>
      )}
      {text && turn.status !== "running" && (
        <div className="mt-1">
          <CopyButton text={text} />
        </div>
      )}
      {turn.usage && (
        <details className="mt-2 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">
            {(
              turn.usage.input_tokens + turn.usage.output_tokens
            ).toLocaleString()}{" "}
            tokens
          </summary>
          <p>
            Input: {turn.usage.input_tokens.toLocaleString()} · Output:{" "}
            {turn.usage.output_tokens.toLocaleString()}
          </p>
        </details>
      )}
    </article>
  );
}
