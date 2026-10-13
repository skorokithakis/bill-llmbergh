---
id: bl-cfxmg
status: closed
deps: [bl-dhwnc]
links: []
created: 2026-10-13T13:23:00Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Custom tools: define/update/delete, registered at startup and on change

Objective: the founder can create shell-command tools that run on the VM, per AGENTS.md 'Custom tools'.

Scope: CustomTools document on the root: { name -> { description, parameters (JSON schema object), command, roles: string[] } }. Founder-only tools define_tool, update_tool, delete_tool. Refuse names that collide with CodingTools, supervisor tools, or worker tools. A function buildCustomToolsExtension(doc) that turns the document into a Durable extension: each tool's execute runs env.exec(command) on the VM with JSON.stringify(args) on stdin and returns stdout (and exit code on failure). Call registry.install() with the rebuilt extension at startup and after every define/update/delete, so the next request sees it. Workers get the custom tools whose roles list includes their role (select the extension per conversation, or filter by role in a second extension; whichever is simpler with Durable's per-conversation extension selection).

Non-goals: tool versioning, parameter validation beyond what Durable does from the schema, tools that run in the container.
Caveats: parameters must be a TypeBox-compatible JSON schema; pass it through as-is and let Durable validate. Check how env.exec accepts stdin in pi-env 1.2.0; if it does not, pass the JSON as an environment variable TOOL_ARGS instead and note it in the founder prompt.

ready for implementation

## Acceptance Criteria

Founder defines a tool, calls it in the next turn, and gets the VM command's stdout. A worker of a listed role can call it; a worker of another role cannot see it. The definition survives a restart.

