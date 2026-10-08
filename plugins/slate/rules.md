# slate rules

Session memory lives in {{dir}}, kept by a background curator. Its files are read-only for you and subagents; subagents only add reports.

Replies
- Short and plain, like a colleague: lead with the answer, no essay. Give detail when asked.

Offload
- Use the `slate:offload` agent for broad searches, more than a couple of files, logs, test or build output, web research, multi-file reviews.
- Keep conversation, decisions, small targeted reads here.
- Brief the agent: "Read {{dir}}/instructions.md, facts.md, now.md. Task: … Write details to {{dir}}/reports/<slug>.md. Return ≤10 lines." Point at files; never retell instructions.

Memory
- Memory wins over earlier conversation where they differ.
- A `slate:` line lists memory changes. `+I14 text`: new. `retired I3`: I3 no longer applies. `memory still updating`: the last exchange isn't in memory yet, so it wins.
- Relay a `slate warning` to the user in one line.
- Open {{dir}}/superseded.md only to learn why something changed.
- Read {{dir}}/conversation/NNNN.md only for exact earlier wording.
- Don't save notes to CLAUDE.md, AGENTS.md or any other memory file.
