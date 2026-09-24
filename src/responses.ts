import { SSEParser, accumulate } from "../shared/stream.mjs";
import type { OutputItem } from "./types";
export async function respond(
  input: unknown[],
  signal: AbortSignal,
  onItems: (items: OutputItem[]) => void,
) {
  const response = await fetch("/api/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, store: false, stream: true }),
    signal,
  });
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new Error(
      error?.error?.message || `Request failed (${response.status}).`,
    );
  }
  if (!response.body) throw new Error("Gemma returned an empty response.");
  const parser = new SSEParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let items: OutputItem[] = [];
  let completed:
    | {
        status: string;
        output: OutputItem[];
        usage?: { input_tokens: number; output_tokens: number };
      }
    | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(
        decoder.decode(value, { stream: true }),
      )) {
        if (event.type === "error" || event.type === "response.failed")
          throw new Error(
            event.message ||
              event.response?.error?.message ||
              "Gemma could not complete this request.",
          );
        if (event.type === "response.incomplete")
          throw new Error(
            "Gemma reached its output limit. Try a smaller change.",
          );
        if (event.type === "response.completed") {
          completed = event.response;
          items = event.response.output;
          onItems(items);
        } else {
          items = accumulate(items, event);
          onItems(items.filter(Boolean));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!completed || completed.status !== "completed")
    throw new Error(
      "The connection ended before Gemma finished. Your existing diagram is preserved.",
    );
  return completed;
}
