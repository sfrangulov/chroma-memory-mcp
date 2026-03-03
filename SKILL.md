---
name: chroma-memory
description: >
  **Shared Team Memory (ChromaDB)**: Use this skill whenever the user mentions
  shared memory, team knowledge, team decisions, or when looking up information
  from the team's knowledge base. Triggers: "запомни для команды", "общая память",
  "что мы решили", "сохрани решение", "добавь в общую память", "shared memory",
  "team memory", "save for the team", "what did we decide", "save this decision",
  "найди в памяти", "search memory". Also triggers when context requires
  information that individual Claude memory wouldn't have (cross-team decisions,
  project architecture, shared documentation).
version: 2.0.0
---

# Chroma Memory MCP

You have access to a shared team knowledge base backed by ChromaDB with semantic
search (Gemini embeddings, multilingual RU+EN). The MCP server is named
`chroma-memory` and exposes 7 tools.

## Tools Reference

| Tool | Purpose | Key params |
|------|---------|------------|
| `list_projects` | List all project names | — |
| `list_entries` | List entries with optional filters | `project?`, `author?`, `type?` |
| `read_entry` | Read full entry by project + slug | `project`, `slug` |
| `write_entry` | Create a new entry | `project`, `slug`, `title`, `content`, `tags?`, `type?` |
| `update_entry` | Update existing entry | `project`, `slug`, + any field to change |
| `delete_entry` | Delete an entry | `project`, `slug` |
| `search` | Semantic search across all entries | `query`, `project?`, `author?`, `n_results?` |

### Entry types

`note` (default), `decision`, `snippet`, `doc`, `log`

### Entry ID format

`{project}:{slug}` — slug must be URL-safe (lowercase, hyphens).

## Core Principles

1. **Never write automatically.** Only save to shared memory when the user
   explicitly asks. Triggers (RU): "запомни для команды", "добавь в память",
   "сохрани". Triggers (EN): "save for the team", "remember this".
2. **Semantic search first.** Use `search` with a natural-language query before
   reading individual entries — it uses Gemini embeddings and works across
   languages (RU+EN).
3. **Explicit source attribution.** When answering from shared memory:
   - RU: "Согласно общей памяти команды, ..."
   - EN: "According to the team's shared memory, ..."
4. **Separation from local memory.** Shared memory != your built-in memory.
   If the user says "запомни" / "remember" without clarification, ask:
   - RU: "В общую память команды или в локальную?"
   - EN: "Save to the team's shared memory or just my local memory?"

## Workflow: Reading & Searching

When the user asks a question that might be in shared memory:

1. Call `search` with a natural-language query derived from the user's question
   - Add `project` filter if context makes the project obvious
   - Default `n_results`: 10 (max 50)
2. Review results — semantic search returns entries ranked by relevance
3. If more detail needed, call `read_entry` on the most relevant slugs
4. Answer the user, citing the source: "**[title]** (project: X)"

**Presenting results:**
- 1-5 entries: show all with brief summaries
- 6-15 entries: compact list (title + project + type)
- >15 entries: first 15 + "Found N entries, please refine your query"

## Workflow: Writing

When the user asks to save something:

1. **Check intent** — local vs shared (see Core Principles #4)
2. **Determine target project:**
   - User names the project explicitly -> use it
   - Context makes it obvious -> use it
   - Otherwise -> call `list_projects`, show options, ask
3. **Check for duplicates:**
   - Call `search` with the proposed content/title
   - If similar entry exists -> show it, ask: "Update existing or create new?"
4. **Prepare entry:**
   - `slug`: short, URL-safe, descriptive (e.g. `auth-decision`, `api-endpoints`)
   - `title`: human-readable (e.g. "Authentication approach decision")
   - `content`: well-structured Markdown
   - `tags`: 2-5 relevant tags, reuse existing tags from the project when possible
   - `type`: pick the most appropriate (`decision` for decisions, `doc` for
     documentation, `snippet` for code, `log` for events, `note` for everything else)
5. Call `write_entry`
6. Confirm to user with entry ID and project

## Workflow: Updating

1. Find the entry via `search` or `list_entries` + `read_entry`
2. Call `read_entry` to get current content
3. Apply changes
4. Call `update_entry` with the modified fields
5. Confirm to user

## Workflow: Deleting

1. Confirm with user before deleting — show entry title and content preview
2. Call `delete_entry`
3. Confirm deletion

## Workflow: Project Discovery

When user starts a session or asks "what's in memory":

1. Call `list_projects` to see all projects
2. Call `list_entries` per project (or without filter for all) to show structure
3. Present a summary table: project, entry count, types, recent updates

## Error Handling

- Entry not found -> suggest `search` with related keywords
- Entry already exists (on write) -> offer to `update_entry` instead
- No results from search -> try broader query, suggest checking `list_entries`

## Bilingual Glossary

| English | Russian | Notes |
|---------|---------|-------|
| project | проект | Translate in narrative |
| shared memory | общая память | Feature name — always translate |
| entry | запись | Always translate |
| tag | тег | Always translate |
| slug | slug | Technical term — never translate |
| search | поиск | Always translate |
| decision | решение | Entry type — translate in narrative |

## Commands Quick Reference

> Note: These are prompting patterns for Claude, not registered CLI commands.

```
/memory <query>     — semantic search in shared memory
/remember <text>    — save a new entry
/projects           — list all projects

Examples:
  /memory what did we decide about auth?
  /memory что мы решили про авторизацию?
  /remember decided to use PostgreSQL for the main DB
  /remember решили использовать Rive вместо Lottie
  /projects
```
