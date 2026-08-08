import { describe, expect, test } from "bun:test";

import {
  formatClaudeSnippet,
  formatCodexExport,
  formatCodexSnippet,
  formatCursorSnippet,
  formatAgentsMd,
  mcpEndpoint,
} from "../cli/snippets";

describe("create-room MCP snippets", () => {
  const url = "https://api.roomd.sh/mcp";
  const key = "rk_test_secret";

  test("mcpEndpoint appends /mcp once", () => {
    expect(mcpEndpoint("https://api.roomd.sh")).toBe("https://api.roomd.sh/mcp");
    expect(mcpEndpoint("https://api.roomd.sh/")).toBe("https://api.roomd.sh/mcp");
    expect(mcpEndpoint("https://api.roomd.sh/mcp")).toBe("https://api.roomd.sh/mcp");
  });

  test("Claude snippet is JSON with type http", () => {
    const parsed = JSON.parse(formatClaudeSnippet(url, key)) as {
      mcpServers: { roomd: { type: string; url: string } };
    };
    expect(parsed.mcpServers.roomd.type).toBe("http");
    expect(parsed.mcpServers.roomd.url).toBe(url);
  });

  test("Cursor snippet is JSON without type", () => {
    const parsed = JSON.parse(formatCursorSnippet(url, key)) as {
      mcpServers: { roomd: { type?: string; url: string } };
    };
    expect(parsed.mcpServers.roomd.type).toBeUndefined();
    expect(parsed.mcpServers.roomd.url).toBe(url);
  });

  test("Codex snippet is TOML with env bearer and no secret", () => {
    const snip = formatCodexSnippet(url);
    expect(snip).toContain("[mcp_servers.roomd]");
    expect(snip).toContain(`url = "${url}"`);
    expect(snip).toContain('bearer_token_env_var = "ROOMD_API_KEY"');
    expect(snip).toContain("tool_timeout_sec = 60");
    expect(snip).not.toContain(key);
    expect(snip).not.toContain("Authorization");
  });

  test("Codex export carries the key", () => {
    expect(formatCodexExport(key)).toBe(`export ROOMD_API_KEY="${key}"`);
  });

  test("AGENTS.md includes heartbeat and chat_turn context logging", () => {
    const md = formatAgentsMd("my-room", "cursor-a");
    expect(md).toContain("roomId: `my-room`");
    expect(md).toContain("agentId: `cursor-a`");
    expect(md).toContain("heartbeat");
    expect(md).toContain('kind: "chat_turn"');
  });
});
