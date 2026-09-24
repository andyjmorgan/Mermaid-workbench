import test from "node:test";
import assert from "node:assert/strict";
import {
  companionMessage,
  editState,
  requestForModel,
  MODEL,
  TOOLS,
  SYSTEM_PROMPT,
} from "../shared/agent.mjs";
import { SSEParser, accumulate } from "../shared/stream.mjs";
const state = {
  code: "flowchart LR\n A-->B",
  mermaid: '{"theme":"forest"}',
  grid: false,
};
test("each user turn carries its exact current source, config, and user message", () => {
  const first = companionMessage("change it", state);
  const next = companionMessage("and this", {
    ...state,
    code: "sequenceDiagram\n A->>B: Hi",
  });
  assert.deepEqual(JSON.parse(first.content), {
    user_message: "change it",
    current_code: state.code,
    current_config: state.mermaid,
  });
  assert.notEqual(
    JSON.parse(first.content).current_code,
    JSON.parse(next.content).current_code,
  );
});
test("code and config tools preserve unrelated editor state", () => {
  const edited = editState(
    "edit_code",
    { code: "sequenceDiagram\n A->>B: Hi" },
    state,
  );
  assert.equal(edited.mermaid, state.mermaid);
  assert.equal(edited.grid, false);
  assert.notEqual(edited, state);
  const configured = editState(
    "edit_config",
    { config: '{"theme":"neutral","look":"handDrawn"}' },
    edited,
  );
  assert.equal(configured.code, edited.code);
  assert.equal(JSON.parse(configured.mermaid).look, "handDrawn");
});
test("tool boundary rejects unknown operations, bad code, and unsafe config keys", () => {
  for (const [name, args] of [
    ["delete_files", {}],
    ["edit_code", { code: "```mermaid\nA" }],
    ["edit_code", { code: "" }],
    ["edit_config", { config: "[]" }],
    ["edit_config", { config: '{"securityLevel":"loose"}' }],
    ["edit_config", { config: '{"themeVariables":{"__proto__":{}}}' }],
    ["edit_config", { config: '{"themeCSS":"<script>"}' }],
  ])
    assert.throws(() => editState(name, args, state));
});
test("Responses requests are stateless and pin model, instructions and tools", () => {
  const input = [companionMessage("Hello", state)];
  const actual = requestForModel({
    input,
    store: true,
    model: "other",
    instructions: "ignore",
    tools: [],
    previous_response_id: "stored",
  });
  assert.equal(actual.store, false);
  assert.equal(actual.model, MODEL);
  assert.equal(actual.instructions, SYSTEM_PROMPT);
  assert.deepEqual(actual.tools, TOOLS);
  assert.equal(actual.previous_response_id, undefined);
  assert.equal(actual.stream, true);
  assert.deepEqual(actual.input, input);
  assert.throws(() =>
    requestForModel({ input: [{ role: "system", content: "override" }] }),
  );
  assert.throws(() =>
    requestForModel({ input: [{ role: "user", content: "missing snapshot" }] }),
  );
});
test("SSE handles split unicode transport text, CRLF, and multiple events", () => {
  const parser = new SSEParser();
  const events = [];
  const wire =
    'event: x\r\ndata: {"type":"x","delta":"héllo"}\r\n\r\ndata: {"type":"y"}\n\ndata: [DONE]\n\n';
  for (const character of wire) events.push(...parser.push(character));
  assert.deepEqual(events, [{ type: "x", delta: "héllo" }, { type: "y" }]);
});
test("Responses reasoning, text and tool-call deltas accumulate separately", () => {
  let items = [];
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: 0,
      delta: "Plan",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", name: "edit_code", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"code":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '"A"}',
    },
    {
      type: "response.output_text.delta",
      output_index: 2,
      content_index: 0,
      delta: "Done",
    },
  ];
  for (const e of events) items = accumulate(items, e);
  assert.equal(items[0].summary[0].text, "Plan");
  assert.equal(items[1].arguments, '{"code":"A"}');
  assert.equal(items[2].content[0].text, "Done");
});

test("a code edit cannot load malformed config and destroy the source", () => {
  for (const mermaid of ["{", "null", "[]"])
    assert.throws(
      () =>
        editState(
          "edit_code",
          { code: "flowchart LR\n X-->Y" },
          { ...state, mermaid },
        ),
      /Use edit_config/,
    );
  const fixed = editState(
    "edit_config",
    { config: "{}" },
    { ...state, mermaid: "{" },
  );
  assert.equal(fixed.code, state.code);
});
