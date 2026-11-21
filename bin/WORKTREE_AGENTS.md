# Parallel agents with shared-dependency worktrees

This repo's `node_modules` is ~66 GB. `bin/worktree-agent.sh` creates real git
worktrees that share the canonical checkout's installed dependencies via
symlinks, so multiple agents can work on different features in parallel without
reinstalling anything.

## Quick start

```bash
# One-time, in the canonical checkout (the repo root):
yarn install                       # already done; rerun only when deps change

# Per feature:
bin/worktree-agent.sh add feat/my-feature main
# -> creates <repo-parent>/actual-worktrees/feat-my-feature
# -> links node_modules and .yarn/cache to the canonical checkout

# Verify health any time:
bin/worktree-agent.sh verify
bin/worktree-agent.sh list
```

The worktree root is derived as `<parent-of-repo>/actual-worktrees`, never
hardcoded. Override with `WORKTREE_ROOT` if needed.

Slugs are derived from branch names: `feature/foo` -> `feature-foo`
(non-alphanumeric characters become `-`, lowercased).

## What is shared vs per-worktree

Shared via symlink from the canonical checkout:

- `node_modules/`
- `.yarn/cache/`

Per-worktree (never shared, so no clobbering):

- `.yarn/install-state.gz`
- build outputs (`lib-dist/`, `dist/`, `build/`)
- `.lage/` cache and `.tsbuildinfo` files
- all tracked source files and your branch

## Rules for agents (include this preamble when spawning)

> You are working in a git worktree that shares installed dependencies with the
> canonical `actual` checkout via symlinks.
>
> - **Never** run `yarn install`, `yarn add`, `yarn remove`, or `yarn up`.
> - **Never** edit `package.json` or `yarn.lock`. If a task requires a
>   dependency change, stop and report it; the coordinator runs
>   `bin/worktree-agent.sh update-deps` in the canonical checkout.
> - Use distinct `PORT` / `E2E_PORT` values if you run a dev server, e.g.
>   `PORT=3002` and `E2E_PORT=3003`, to avoid colliding with other agents.
> - Do not remove or replace the `node_modules` or `.yarn/cache` symlinks. If
>   you need a different native-module ABI, report it instead.
>
> GitHub access rules (see `bin/with-actual-github.sh --preamble`):
>
> - A `GITHUB_TOKEN` may be present in your environment. **Never** print,
>   echo, log, or write its value anywhere — not to files, commits, PR bodies,
>   comments, config, or tool calls.
> - Use `gh` / MCP GitHub tools that read the token from the environment
>   implicitly; never pass the token as an argument.
> - Only operate on the `actual` repository (`actualbudget/actual`) and its
>   worktrees with this token.
> - Before opening a PR, follow all repo rules: `[AI]`-prefixed title, blank PR
>   template, never skip hooks with `--no-verify`.
> - Regenerate i18n (`yarn generate:i18n`) after changing user-facing strings;
>   run `yarn typecheck` before committing.

## Paseo workflow (recommended)

1. Create a Paseo workspace for each feature:

   ```
   paseo_create_workspace:
     isolation: "worktree"
     mode: "branch-off"
     branchName: "feat/my-feature"
     baseBranch: "main"
   ```

   Paseo creates and registers the worktree as a first-class workspace.

2. If Paseo's worktree path is not under `actual-worktrees`, run the following
   inside it to link the shared dependencies:

   ```bash
   cd <paseo-worktree-path>
   <repo-root>/bin/worktree-agent.sh link-here
   ```

   (`link-here` works on any worktree, not just ones created by `add`.)

3. Spawn an agent bound to that workspace:

   ```
   paseo_create_agent:
     workspaceId: <from step 1>
     provider: "opencode"
     settings.modeId: "build"
     initialPrompt: <task + the preamble above>
   ```

4. Review and merge each branch back to `main` sequentially. After merging any
   change that touches `package.json` / `yarn.lock`, run:

   ```bash
   bin/worktree-agent.sh update-deps
   ```

   in the canonical checkout. All worktrees see the result immediately through
   their symlinks.

## GitHub token scoping

The token is **not** stored in the repo. It lives at:

```
<parent-of-repo>/.secrets/actual-github.env   # GITHUB_TOKEN=...
```

- `bin/with-actual-github.sh --check` verifies the file exists, has mode `600`,
  and defines `GITHUB_TOKEN` — without printing the value.
- `bin/with-actual-github.sh <command> [args...]` sources the env file and runs
  the command with the token in its environment. Use this only when launching
  agents whose cwd is `actual` or one of its worktrees.
- `bin/with-actual-github.sh --preamble` prints the token safety rules above.
- `opencode.json` (gitignored) may reference the token as `${GITHUB_TOKEN}` for
  the GitHub MCP; it must never contain a literal token.

Agents for other projects must not receive `GITHUB_TOKEN`. Do not set it in a
system-wide shell profile.

## Cleanup

```bash
bin/worktree-agent.sh remove feat/my-feature   # unlink + remove worktree
git branch -d feat/my-feature                  # delete the branch when done
```

## Caveats

- **Single lockfile state.** Parallel dependency upgrades on different
  branches cannot share one `node_modules`; do those in isolation.
- **Shared build caches.** `node_modules/.cache`, Vite, and esbuild caches are
  shared along with `node_modules`. Concurrent dev-server / build runs in
  different worktrees can race on these caches. Prefer running heavy builds in
  one worktree at a time, or give each agent its own cache dir via env vars.
- **`update-deps` needs a quiescent window.** Running `yarn install` in the
  canonical checkout while other agents are mid-build can briefly break their
  symlinked deps. Coordinate a pause before running it.
- **Native ABI divergence.** An agent that genuinely needs a different native
  build must replace its symlink with a private install; `verify` will flag the
  drift so it is never silent.
- **`bin/run-vrt`** auto-runs `yarn` if `node_modules` is empty. Run `verify`
  first; a dangling symlink is caught there.
- **Dev server ports.** Use `PORT` / `E2E_PORT` overrides per agent.
- **Removing Paseo-created worktrees.** `remove <branch>` only resolves paths
  under `<repo-parent>/actual-worktrees`. For worktrees created elsewhere,
  unlink the deps and use `git worktree remove <path>` directly.
