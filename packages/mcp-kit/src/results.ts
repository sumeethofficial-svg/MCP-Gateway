import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Successful tool result. Returns the payload both as compact JSON text (for
 * clients/models that only read `content`) and as `structuredContent`.
 */
export function ok<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Tool-level failure. Reported with isError so the model can read and react to it. */
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Annotations for tools that never mutate anything. The gateway uses these for default permissions. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Annotations for tools that create or change data. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
