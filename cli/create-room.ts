#!/usr/bin/env bun
/**
 * roomd create-room — claim a room and print MCP client config snippets.
 *
 * Usage:
 *   ROOMD_URL=https://api.roomd.sh ROOMD_API_KEY=... bun cli/create-room.ts [roomId] [--template web-app]
 */

import {
  formatAgentsMd,
  formatClaudeSnippet,
  formatCodexExport,
  formatCodexSnippet,
  formatCursorSnippet,
  mcpEndpoint,
} from "./snippets";

const url = (process.env["ROOMD_URL"] ?? "http://localhost:3010").replace(/\/$/, "");
const key = process.env["ROOMD_API_KEY"] ?? process.env["ROOMD_MASTER_KEY"];

if (!key) {
  console.error("Set ROOMD_API_KEY (or ROOMD_MASTER_KEY) to a team API key.");
  process.exit(1);
}

const args = process.argv.slice(2);
let roomId: string | undefined;
let templateId: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--template") {
    templateId = args[++i];
  } else if (!args[i]?.startsWith("-")) {
    roomId = args[i];
  }
}

async function main() {
  let createdRoomId = roomId;

  if (templateId) {
    // Use MCP tools/call via JSON-RPC over streamable HTTP is heavy for CLI;
    // hit admin create + then we'd need MCP. Simpler: POST /admin/rooms then
    // instruct user to call create_room_from_template — OR call MCP.
    // Prefer admin rooms + document template via MCP for agents.
    const res = await fetch(`${url}/admin/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
    const data = (await res.json()) as { roomId: string };
    createdRoomId = data.roomId;

    // Seed via MCP tools/call
    const mcp = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_room_from_template",
          arguments: { templateId, roomId: createdRoomId },
        },
      }),
    });
    if (!mcp.ok) {
      console.error("Room created but template seed failed:", await mcp.text());
    }
  } else {
    const res = await fetch(`${url}/admin/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId }),
    });
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
    const data = (await res.json()) as { roomId: string };
    createdRoomId = data.roomId;
  }

  const mcpUrl = mcpEndpoint(url);
  console.log(`Room: ${createdRoomId}`);
  console.log("");
  console.log("Claude Code (.claude/settings.json snippet):");
  console.log(formatClaudeSnippet(mcpUrl, key));
  console.log("");
  console.log("Cursor (mcp.json snippet):");
  console.log(formatCursorSnippet(mcpUrl, key));
  console.log("");
  console.log("Codex (~/.codex/config.toml snippet):");
  console.log(formatCodexSnippet(mcpUrl));
  console.log("");
  console.log(formatCodexExport(key));
  console.log("");
  console.log("AGENTS.md / CLAUDE.md:");
  console.log(formatAgentsMd(createdRoomId ?? "your-room"));
  console.log("");
  console.log(`Tell your agent: room id is ${createdRoomId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
