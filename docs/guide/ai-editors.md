# AI editors

A convention-driven framework is only pleasant if your assistant knows the
conventions. Left to guess, coding agents reach for the patterns they have seen
most: an Express-style router file, a DI container assembled by hand, providers
imported directly from one module into another. All three fight the framework.

One command writes CloveJS's conventions into your project, in each editor's own
format:

```bash
npx clove skills
```

| Editor | File it reads |
| --- | --- |
| Claude Code | `.claude/skills/clovejs/SKILL.md` |
| Cursor | `.cursor/rules/clovejs.mdc` |
| Antigravity | `.antigravity/rules/clovejs.md` |
| Codex, Gemini CLI, Jules, … | `AGENTS.md` |

Install a subset by name:

```bash
npx clove skills --ide cursor,codex
```

Known ids are `claude`, `cursor`, `antigravity` and `codex`; anything else is
rejected with the list of what is valid, so a typo does not silently write
nothing.

## What gets written

The same body of guidance every time — the directory conventions, the
filename-to-method rule, return-value semantics, DI lifetimes and their
resolution order, middleware ordering, the WebSocket middleware caveat, and a
short checklist for editing a Clove project. Only the front matter differs, so
what Cursor sees and what Claude Code sees cannot drift apart.

Editors that scope rules by path get globs for `api/`, `ws/`, `di/`,
`services/`, `middlewares/` and `main.*`, so the guidance activates when it is
relevant instead of occupying context on every unrelated file.

## Ownership and re-runs

Files under `.claude/`, `.cursor/` and `.antigravity/` belong to the command.
An existing one is reported as `skipped` and left untouched; pass `--force` to
overwrite deliberately. The same rule `clove scaffold` follows.

`AGENTS.md` is different, because it is yours and usually holds instructions
that have nothing to do with CloveJS. The command maintains a single delimited
block there and preserves everything around it:

```markdown
# AGENTS.md

Your own house rules stay exactly where they are.

<!-- clovejs:begin -->
## CloveJS
...
<!-- clovejs:end -->
```

Re-running refreshes that block in place rather than appending a second copy,
so running the command after every CloveJS upgrade is safe and idempotent. If
the block is already current, the file is not rewritten at all.

## Commit the result

These are project configuration, not personal editor settings: everyone working
in the repository — and every agent any of them runs — benefits from the same
conventions. Check them in.

::: tip Keep it paired with `clove types`
Instructions tell an assistant *where* code goes; [typed
context](/guide/typed-context) tells its type checker *what* `ctx` holds. The
two together are what make an agent's first attempt compile. After adding a
service or a `di/` value, run `npx clove types`.
:::
