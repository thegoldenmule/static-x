# static-x

Source-code tools for LLMs, built on language servers and static analysis instead of text search. Every tool answers questions through symbol tables, ASTs, or LSP capabilities — precise, resolved answers rather than grep output.

Each language has its own directory containing the machinery to run its language server, bind to a project on disk, and ferry tool calls, plus the tools themselves.

- **[TypeScript tools](ts/README.md)** — the available tools and what they do
- **[Project plan](docs/plan.md)** — architecture, tool contracts, and milestones

Run a tool:

```sh
npm run sx -- ts/comments/long --project path/to/project
```

Output is JSON findings (or edits); exit code 0 means clean, 1 means findings, 2 means error.
