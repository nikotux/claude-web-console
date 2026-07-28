---
name: handoff
description: Session handoff for ticket/TASK work — writes findings, status, and next step as a structured comment on the Pad TASK (plus Honcho for reusable facts, when configured) so the next chat starts with context and audits are easy to reconstruct. Use when wrapping up work on a TKT/TASK, or when the user says "handoff", "cerrar sesión", "guardar progreso", "deja anotado el avance", or similar.
cwc-share: catalog
cwc-default: true
---

# Ticket work handoff

Goal: leave durable, structured context on the Pad TASK being worked, so a new
chat (or another dev/agent) can resume without re-discovering anything, and an
audit can reconstruct the work trail end to end (Pad = dev work, git = code,
`audit_log` = system actions).

Pad is the source of truth for dev-work progress. Tolkien's own DB
(`event_inbox`, `audit_log`) audits what the *system* did — never write dev
findings there.

## Steps

1. **Identify the active TASK.** From the conversation, determine which Pad
   TASK (`TASK-XX`) this session worked on. If ambiguous, ask the user. If the
   work has no TASK yet, offer to create one first (via the `pad` skill), then
   hand off onto it.

2. **Compose the handoff comment** (in English — Pad comments are team-facing
   artifacts) using this exact template:

   ```markdown
   ## Session handoff — <YYYY-MM-DD>
   **Status:** in progress | blocked | ready-for-review
   **Findings:** what was discovered (with file:line where applicable)
   **Ruled out:** hypotheses eliminated (so the next session doesn't repeat them)
   **Next step:** the single concrete next action
   **Branch / files:** branch name + files touched
   ```

   Rules:
   - Findings must be specific enough to act on without re-reading this
     session's transcript.
   - "Ruled out" is as valuable as "Findings" — dead ends cost the most to
     repeat.
   - "Next step" is ONE concrete action, not a list of maybes.
   - Omit sections that would be empty rather than writing "N/A".

3. **Show the draft to the user for a quick OK** (it carries their name), then
   post it as a comment on the Pad TASK via the `pad` skill.

4. **Reusable facts → Honcho** (optional; only if the `honcho` CLI is
   installed and configured for this user — check with `which honcho` and skip
   silently otherwise). Only durable, cross-session facts qualify: root
   causes, codebase gotchas, non-obvious system behavior. Ephemeral progress
   ("halfway through X") does NOT go to Honcho — that's what the Pad comment
   is for.

5. **Confirm** with a short visual summary: TASK updated ✅, Honcho
   written/skipped, and the recorded next step.

## Session-start counterpart

When a session starts on an existing TKT/TASK, read the TASK's latest
"Session handoff" comment FIRST (via the `pad` skill) before investigating
anything — it is the starting point.
