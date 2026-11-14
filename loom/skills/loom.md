---
name: loom
description: Recall and update Loom's project memory. Use when the user asks about their project, wants to continue coding, or mentions what they are building.
---

# Loom — Project Memory Skill

Use this skill to help users access their Loom project memory and continue coding sessions with full context.

## When to activate

- User says "continue my project", "what was I working on", "pick up where I left off"
- User asks what Loom remembers about their project
- User mentions their codebase, stack, or current task
- User wants to start a new coding session

## What Loom remembers

Loom stores per-user project memory in Anna's persistent storage:
- **project_name** — the name of the project
- **stack** — detected technologies and frameworks
- **purpose** — one-sentence description of what the project does
- **current_focus** — what the developer was actively working on
- **key_decisions** — important architectural or technical choices
- **tried_and_abandoned** — things that were attempted and removed
- **where_left_off** — the state at the end of the last session

## How to help

1. Invoke `get_memory` via the Loom tool to retrieve the user's current project memory
2. Present it naturally — tell the user what their project is and where they left off
3. Ask what they want to work on next
4. Direct them to open the Loom app for a full session with live workspace access

## Example interactions

**User:** "What was I building again?"
**Response:** Check memory, then say: "You're building [project_name] — [purpose]. Last session you were focused on [current_focus] and left off at [where_left_off]. Want to continue?"

**User:** "Continue my project"
**Response:** "Opening Loom for you. You were working on [project_name] — [where_left_off]. Start a session to pick up where you left off."

**User:** "What does Loom know about my stack?"
**Response:** Retrieve memory and list the detected stack technologies naturally.
