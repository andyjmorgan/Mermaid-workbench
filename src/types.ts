export type OutputItem = {
  id?: string;
  type: string;
  role?: string;
  status?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  summary?: { type: string; text: string }[];
  content?: { type: string; text: string }[];
  [key: string]: unknown;
};
export type EditorState = {
  code: string;
  mermaid: string;
  [key: string]: unknown;
};
export type ToolResult = {
  output: string;
  success: boolean;
  durationMs: number;
  before?: EditorState;
  after?: EditorState;
};
export type Turn = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  snapshot?: EditorState;
  items?: OutputItem[];
  tools?: Record<string, ToolResult>;
  status?: "running" | "complete" | "error" | "stopped";
  note?: string;
  usage?: { input_tokens: number; output_tokens: number };
};
