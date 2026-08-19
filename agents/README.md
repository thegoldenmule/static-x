# Agents

Claude Code agent definitions that `static-x install` copies into a project's `.claude/agents/`,
kept in the tree so the prompt an agent follows is a reviewable file with a history rather than a
string generated at install time.

| Agent | Description |
| --- | --- |
| [`comment-tightener`](comment-tightener.md) | Drives every comment block down to a configured line budget through the baseline/ratchet loop |

The division of labour with `.claude/skills/static-x-backlog` is deliberate: the skill spends down
a backlog of findings the packs already vouch for, and refuses comment-length findings because a
threshold is taste. An agent here exists for a campaign a human has explicitly mandated — its setup
writes that mandate into `static-x.json` before it touches a file.
