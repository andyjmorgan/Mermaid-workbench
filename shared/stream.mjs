// Responses SSE events can split anywhere across transport chunks.
export class SSEParser {
  buffer = "";
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const record = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = record
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") events.push(JSON.parse(data));
    }
    return events;
  }
}
export function accumulate(items, event) {
  const next = structuredClone(items);
  const i = event.output_index;
  if (
    event.type === "response.output_item.added" ||
    event.type === "response.output_item.done"
  )
    next[i] = event.item;
  else if (event.type === "response.output_text.delta") {
    const item = next[i] ?? { type: "message", role: "assistant", content: [] };
    item.content ??= [];
    const part = event.content_index ?? 0;
    item.content[part] ??= { type: "output_text", text: "" };
    item.content[part].text += event.delta;
    next[i] = item;
  } else if (
    event.type === "response.reasoning_summary_text.delta" ||
    event.type === "response.reasoning_text.delta"
  ) {
    const item = next[i] ?? { type: "reasoning", summary: [] };
    item.summary ??= [];
    const part = event.summary_index ?? 0;
    item.summary[part] ??= { type: "summary_text", text: "" };
    item.summary[part].text += event.delta;
    next[i] = item;
  } else if (event.type === "response.function_call_arguments.delta") {
    const item = next[i] ?? { type: "function_call", arguments: "" };
    item.arguments = (item.arguments ?? "") + event.delta;
    next[i] = item;
  }
  return next;
}
