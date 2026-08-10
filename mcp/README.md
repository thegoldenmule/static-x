# MCP server

Exposes every registered tool over the Model Context Protocol (stdio). Tool names swap `/` for `_` — `ts/comments/stale-refs` becomes `ts_comments_stale-refs` — and every tool takes the underlying tool's input plus a required `projectRoot`.

Analysis tools also take an optional `files` list, so a model can check what it just changed instead of the whole project: findings are reported only in those files, while the analysis behind them still spans the project ([details](../README.md#check-only-what-changed)). `ts_refactors_rename` doesn't offer it — a partial file list would mean a partial refactor.

Results are typed: each tool advertises an `outputSchema` that wraps the tool's own output schema under a single `result` property (MCP requires structured results to be JSON objects, while finding tools return arrays), and successful calls return `structuredContent: { result }` alongside the same value serialized as JSON text content for text-only clients. Errors come back as `isError` text with no `structuredContent`.

Sessions are cached per project root for the life of the server process, so repeated calls in one conversation reuse the running language server and typechecked program instead of paying startup cost each time.

## Registering with Claude Code

After [installing](../README.md#install) (`npm install` + `npm link` in this repo):

```sh
claude mcp add static-x -- static-x-mcp
```

Without `npm link`, point at the shim directly:

```sh
claude mcp add static-x -- node /absolute/path/to/static-x/mcp/sx-mcp.mjs
```

Then ask Claude things like *"run stale-refs on this project"*, *"check the files I just changed for type loopholes"*, or *"rename makeOptions to buildOptions (dry-run first)"* — the tool descriptions and schemas are written for the model to drive directly.

To run the same checks automatically rather than on request, see the [example hooks](../hooks/README.md).

## Running standalone

```sh
static-x-mcp   # speaks MCP on stdio (or: npm run mcp from this repo)
```
