# Working on PropertyYield AI

## Which model does what

- Planning and design decisions: Opus (the project default model is `opusplan`: Opus in plan mode, Sonnet when carrying out the plan).
- Implementation work handed to agents: Sonnet (`implementer` agent; all subagents default to Sonnet via `CLAUDE_CODE_SUBAGENT_MODEL`).
- Simple tasks (find code, read and summarise, one-line edits, check a URL): Haiku (`quick-helper` agent).

Prefer delegating implementation and simple lookups to these agents instead of doing everything on the planning model.
