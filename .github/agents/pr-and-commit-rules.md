# PR and Commit Rules for AI Agents

This file lists the PR and commit rules you have to apply yourself.

## Pull Request Rules

### `[AI]` prefix on PR titles

**ALL pull request titles MUST be prefixed with `[AI]`** — you have to apply it
yourself.

**Examples:**

- `[AI] Fix type error in account validation`
- `Fix type error in account validation` (MISSING PREFIX — NOT ALLOWED)

### Fill in the PR template

When you create a pull request, **fill in the template**
(`.github/PULL_REQUEST_TEMPLATE.md`) — a human asking for a PR expects a ready-to-
review description, not a blank form. Write the Description, Related issue(s),
Testing and Checklist sections in **English**, in the PR's normal voice.

- Make the Description say what the change does and why, and disclose that an
  agent filled it out: make the **first line of the Description body**
  `🤖 This description was filled in by an AI agent.` This satisfies the
  template's AI-usage disclosure comment, and is the same 🤖 marker used for
  agent-authored comments below.
- Check a checklist box only for a claim you actually verified (for example,
  that a release note was added or that lint and tests pass). Leave boxes that
  need human judgement — such as self-review — **unchecked**.
- Keep the template's placeholder comments and structure; write the requested
  content under each section heading. If there is no related issue, write `None`.

## Do not create GitHub issues

**Agents must never create GitHub issues.** Filing an issue is a human
decision — neither the GitHub MCP tools (`issue_write` with method `create`)
nor the `gh` CLI (`gh issue create`) may be used to open one; agent hooks
block both. If you believe an issue should exist, share the proposed title
and body with the user and let them file it. Updating existing issues (and
commenting on them) remains allowed.

## GitHub comment, review and issue prefix

**Prefix everything you post to GitHub with the robot emoji 🤖** — PR bodies
(see the template rule above), pull-request and issue comments, pull-request
reviews (including inline review comments), and the title and body of issues you
edit. This keeps agent-authored content
visibly marked. It does **not** change PR titles (still `[AI] …`) or commit
messages (still `[AI] …`).

Write the text normally; just make sure 🤖 is the first character (for issues,
on both the title and the body).

This applies only to comments **you** author — bots like CodeRabbit post under
their own identity and are not affected.
