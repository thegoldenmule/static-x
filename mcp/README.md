# MCP server

Exposes every registered tool over the Model Context Protocol (stdio). Tool names swap `/` for `_` — `ts/comments/stale-refs` becomes `ts_comments_stale-refs` — and every tool takes the underlying tool's input plus a required `projectRoot`.

Sessions are cached per project root for the life of the server process, so repeated calls in one conversation reuse the running language server and typechecked program instead of paying startup cost each time.

## Registering with Claude Code

From this repository:

```sh
claude mcp add static-x -- npx tsx /absolute/path/to/static-x/mcp/main.ts
```

Then ask Claude things like *"run stale-refs on this project"* or *"rename makeOptions to buildOptions (dry-run first)"* — the tool descriptions and schemas are written for the model to drive directly.

## Running standalone

```sh
npm run mcp   # speaks MCP on stdio
```
