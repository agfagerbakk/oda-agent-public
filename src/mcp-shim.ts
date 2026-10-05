import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ZodRawShape } from "zod";

// MCP plumbing shared by the OpenAI agent loop, the in-process local tools,
// and the test fixtures. Replaces the `createSdkMcpServer`/`tool` helpers that
// used to come from the Claude Agent SDK (which can't drive OpenAI models).

/** A tool definition, mirroring the old SDK helper's shape. */
export type ToolDef = {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<{
    content: { type: "text"; text: string }[];
  }>;
};

export function tool(
  name: string,
  description: string,
  inputSchema: ZodRawShape,
  handler: ToolDef["handler"],
): ToolDef {
  return { name, description, inputSchema, handler };
}

/** MCP server configs the agent loop can bridge into OpenAI function tools. */
export type StdioServerConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
};

export type SdkServerConfig = {
  type: "sdk";
  name: string;
  instance: McpServer;
};

export type McpServerConfig = StdioServerConfig | SdkServerConfig;

/** Build an in-process MCP server (local tools, test fakes). */
export function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: ToolDef[];
}): SdkServerConfig {
  const server = new McpServer(
    { name: options.name, version: options.version ?? "1.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const t of options.tools ?? []) {
    server.tool(t.name, t.description, t.inputSchema, async (args) => t.handler(args));
  }
  return { type: "sdk", name: options.name, instance: server };
}

export type BridgedServer = {
  key: string;
  client: Client;
  /** Release the connection (terminates stdio children; detaches in-memory). */
  close: () => Promise<void>;
};

/**
 * Connect an MCP client to a configured server. `sdk` (in-process) servers
 * connect once and the connection is reused across turns; `stdio` servers
 * spawn a child per connection and must be closed after the turn.
 */
const sdkClients = new Map<McpServer, Client>();

export async function connectMcpServer(key: string, cfg: McpServerConfig): Promise<BridgedServer> {
  if (cfg.type === "sdk") {
    let client = sdkClients.get(cfg.instance);
    if (!client) {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await cfg.instance.connect(serverT);
      client = new Client({ name: "oda-agent", version: "0.1.0" });
      await client.connect(clientT);
      sdkClients.set(cfg.instance, client);
    }
    return { key, client, close: async () => {} };
  }
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    // Drop undefined entries (process.env spread) — the transport wants strings.
    env: Object.fromEntries(Object.entries(cfg.env ?? {}).filter(([, v]) => v !== undefined)) as Record<
      string,
      string
    >,
  });
  const client = new Client({ name: "oda-agent", version: "0.1.0" });
  await client.connect(transport);
  return {
    key,
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Flatten an MCP tool result into plain text for the model. */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown[] } | null)?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? "");
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (typeof b?.text === "string") parts.push(b.text);
    else parts.push(JSON.stringify(block));
  }
  return parts.join("\n");
}
