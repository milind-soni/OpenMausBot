---
edubot: 1
kind: mcp-server
key: notion
description: Acme's Notion workspace
transport: http
url: https://mcp.notion.com/mcp
headers:
  Authorization: { secret: NOTION_TOKEN }
---
Each person fills NOTION_TOKEN with their own Notion integration token, written as "Bearer <token>".
