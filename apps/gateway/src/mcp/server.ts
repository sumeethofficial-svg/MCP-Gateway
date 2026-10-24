import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Principal } from "../auth/principal.js";
import { GatewayService, UnknownToolError } from "./gateway-service.js";

export type GatewayMode = "full" | "lazy";

export interface McpSessionOptions {
  mode: GatewayMode;
  requestId: string;
  clientName?: string;
}

const FULL_INSTRUCTIONS =
  "This is a team MCP gateway. It aggregates several MCP servers behind one endpoint. " +
  "Every tool is named <server>__<tool>, so identically named tools on different servers never collide. " +
  "You only see the tools your account is allowed to use.";

const LAZY_INSTRUCTIONS =
  "This gateway aggregates many tools. To keep your context small it exposes three meta tools instead of the full list: " +
  "call gateway__search_tools with a short description of what you need, optionally gateway__describe_tool for a tool's input schema, " +
  "then gateway__call_tool with the exact tool name and its arguments.";

const SEARCH_ARGS = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(20).optional() });
const DESCRIBE_ARGS = z.object({ name: z.string().trim().min(1).max(200) });
const CALL_ARGS = z.object({ name: z.string().trim().min(1).max(200), arguments: z.record(z.string(), z.unknown()).optional() });

export const META_TOOLS: Tool[] = [
  {
    name: "gateway__search_tools",
    description: "Search the available tools by keyword. Returns tool names with short descriptions. Always do this first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, e.g. 'orders today' or 'convert currency'" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results (default 10)" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "gateway__describe_tool",
    description: "Get the full description and input schema of one tool returned by gateway__search_tools.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Exact tool name" } }, required: ["name"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "gateway__call_tool",
    description: "Call any tool by its exact name with a JSON arguments object. The call is permission-checked and audited exactly like a direct call.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact tool name, e.g. woo__list_orders" },
        arguments: { type: "object", description: "Arguments matching the tool's input schema", additionalProperties: true },
      },
      required: ["name"],
    },
  },
];

const text = (value: unknown, isError = false): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(typeof value === "object" && value !== null && !isError ? { structuredContent: value as Record<string, unknown> } : {}),
});

/**
 * Builds the MCP server a single authenticated request talks to. It is stateless and cheap:
 * the principal is baked in, so every handler runs "as" the caller.
 */
export function createGatewayMcpServer(service: GatewayService, principal: Principal, opts: McpSessionOptions): Server {
  const server = new Server(
    { name: "mcp-portal-gateway", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } }, instructions: opts.mode === "lazy" ? LAZY_INSTRUCTIONS : FULL_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.mode === "lazy") return { tools: META_TOOLS };
    const { tools } = await service.listVisibleTools(principal);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args = request.params.arguments as Record<string, unknown> | undefined;
    const ctx = { requestId: opts.requestId, clientName: opts.clientName, signal: extra.signal };

    try {
      if (opts.mode === "lazy") {
        if (name === "gateway__search_tools") {
          const parsed = SEARCH_ARGS.safeParse(args);
          if (!parsed.success) return text(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`, true);
          return text({ results: await service.searchTools(principal, parsed.data.query, parsed.data.limit) });
        }
        if (name === "gateway__describe_tool") {
          const parsed = DESCRIBE_ARGS.safeParse(args);
          if (!parsed.success) return text("Invalid arguments: name is required", true);
          const tool = await service.describeTool(principal, parsed.data.name);
          return tool ? text({ tool }) : text(`No tool named "${parsed.data.name}" is available to you.`, true);
        }
        if (name === "gateway__call_tool") {
          const parsed = CALL_ARGS.safeParse(args);
          if (!parsed.success) return text("Invalid arguments: name is required and arguments must be an object", true);
          return await service.callTool(principal, parsed.data.name, parsed.data.arguments, ctx);
        }
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${name}". In lazy mode only the gateway__* meta tools exist.`);
      }
      return await service.callTool(principal, name, args, ctx);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, err.message);
      throw new McpError(ErrorCode.InternalError, "The gateway failed to process this request");
    }
  });

  return server;
}
