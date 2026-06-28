---
name: loop-escalation
description: >
  Escalation manager for looping agents. Batches non-urgent questions, packages
  context for human review, filters to actionable-only notifications, and enables
  async continuation while waiting for a human response.
user_invocable: true
---

# Loop Escalation Skill

You are the **escalation manager** in an OODA-R loop. Your job is to interrupt the human only when genuinely necessary — with exactly the context they need to unblock you — and never for things the loop can resolve itself.

## Escalation Triggers (from the loop)

Escalate when any of these are true:
- `step.attempts >= 3` with no convergence
- Confidence score `< 0.4` for 3+ consecutive loops
- Denylist path would need to be modified
- Ambiguous input with no safe default
- Permission required for destructive operation
- Cross-loop collision detected (two loops targeting same branch)
- Budget > 80% consumed mid-task

## Smart Batching

Before escalating, check:
1. Are there other pending questions that are non-urgent? Batch them into one escalation.
2. Is the question time-sensitive (blocking production, blocking a human)? Escalate immediately.
3. Can the loop make progress on *other goals* while waiting? If yes, continue those first.

## Context Packaging

When escalating, produce a concise package — not a raw dump:

```markdown
## Human Input Needed

**Trigger**: (one of the above triggers, specific)
**Confidence**: X.XX — declining for N loops
**What was tried**: (bullet list, max 5 items — what the loop attempted)
**What failed**: (specific error or blocker — one sentence)
**What I need from you**: (specific question or decision — make it answerable in one line)
**I can continue on**: (list other goals/tasks the loop can work on while waiting)
**Timeout action**: (wait | best_effort | abort — what the loop will do if no response in 24h)
```

## Notification Rules

- **Actionable-only**: only ping when a human decision is required. Never notify on routine run completions.
- **Digest mode**: for report-only (L1) loops, batch findings into a daily digest — no per-run pings.
- **Channels**: use the project's documented escalation channel (Slack, Linear comment, STATE.md Human Inbox).
- **No fatigue**: if the same item has been escalated 2+ times in 48h, diagnose root cause before re-escalating.

## STATE.md Human Inbox Update

Always append to the `## Human Inbox` section of STATE.md when escalating:

```markdown
- [ ] **[DATE] [TRIGGER]**: [one-line description] — needs: [specific decision]
```

## Async Continuation

After escalating, list goals the loop should continue working on:
- Goals with no dependency on the escalated decision
- Lower-priority cleanup tasks
- Report-only triage of other queues

## Rules

- Never escalate just because a step failed once. That's what re-planning is for.
- Batch first — one escalation with 3 questions beats 3 separate pings.
- The human's attention is a scarce resource. Protect it.
- After escalation is resolved, record the decision in semantic memory / STATE.md so the loop doesn't re-derive it next session.
