#!/bin/sh
# Manage git worktrees that share the canonical checkout's installed dependencies.
#
# The canonical checkout is the directory containing this script's parent (i.e.
# the repo root). Worktrees are created under <parent-of-repo>/actual-worktrees
# by default, or under $WORKTREE_ROOT when set. Dependencies (node_modules and
# .yarn/cache) are symlinked from the canonical checkout into each worktree so
# agents never need to repeat the (very large) install.
#
#   bin/worktree-agent.sh add <branch> [base-ref]
#   bin/worktree-agent.sh link-here
#   bin/worktree-agent.sh list
#   bin/worktree-agent.sh verify [branch]
#   bin/worktree-agent.sh remove <branch>
#   bin/worktree-agent.sh update-deps
#   bin/worktree-agent.sh help
#
# See bin/WORKTREE_AGENTS.md for the full workflow, including the Paseo agent
# preamble and the GitHub token scoping rules.

set -eu

# --- Resolve script directory portably (POSIX sh, no BASH_SOURCE) ------------
SCRIPT_PATH="$0"
case "$SCRIPT_PATH" in
    */*) ;;
    *) SCRIPT_PATH="$(command -v -- "$SCRIPT_PATH")" ;;
esac
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)"

# Canonical repo root is the parent of the directory holding this script.
CANONICAL="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# Worktree root is a sibling of the repo: <parent-of-repo>/actual-worktrees.
if [ -n "${WORKTREE_ROOT:-}" ]; then
    WT_ROOT="$(cd "$WORKTREE_ROOT" 2>/dev/null && pwd -P || printf '%s' "$WORKTREE_ROOT")"
else
    WT_ROOT="$(cd "$(dirname "$CANONICAL")" && pwd -P)/actual-worktrees"
fi

MARKER=".worktree-deps.json"

# --- Helpers ----------------------------------------------------------------
slugify() {
    printf '%s' "$1" | sed 's|[^A-Za-z0-9._-]|-|g' | tr '[:upper:]' '[:lower:]'
}

worktree_dir() {
    slug="$(slugify "$1")"
    # A branch of only punctuation would produce an empty or all-dash slug,
    # which is degenerate (and, if empty, would resolve to $WT_ROOT itself).
    case "$slug" in
        *[A-Za-z0-9]*) ;;
        *) printf 'ERROR: branch name produces an invalid worktree slug: %s\n' "$1" >&2; return 1 ;;
    esac
    printf '%s/%s' "$WT_ROOT" "$slug"
}

marker_path() {
    printf '%s/%s' "$1" "$MARKER"
}

# Print a JSON string literal, escaping backslash, quote and control chars.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g'
}

# Ensure a symlink at $2 points to $1. Refuse to overwrite anything that
# already exists (a real directory, a file, or a different symlink).
link_deps() {
    ld_source="$1"
    ld_link="$2"
    ld_name="$3"

    if [ -L "$ld_link" ]; then
        ld_current="$(readlink "$ld_link")"
        if [ "$ld_current" = "$ld_source" ]; then
            printf '  ok: %s already links to canonical\n' "$ld_name"
            return 0
        fi
        printf 'ERROR: %s is a symlink to %s, expected %s\n' "$ld_name" "$ld_current" "$ld_source" >&2
        return 1
    fi
    if [ -e "$ld_link" ]; then
        printf 'ERROR: %s already exists and is not a symlink; refusing to overwrite\n' "$ld_name" >&2
        return 1
    fi
    if [ ! -e "$ld_source" ]; then
        printf 'ERROR: source does not exist: %s\n' "$ld_source" >&2
        return 1
    fi
    ln -s "$ld_source" "$ld_link"
    printf '  linked: %s -> %s\n' "$ld_name" "$ld_source"
}

# Write the marker recording where the deps come from.
write_marker() {
    wt="$1"
    cat > "$(marker_path "$wt")" <<EOF
{
  "canonical": "$(json_escape "$CANONICAL")",
  "node_modules": "$(json_escape "$CANONICAL/node_modules")",
  "yarn_cache": "$(json_escape "$CANONICAL/.yarn/cache")",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

# Verify a single worktree's dependency links. Returns non-zero on drift.
# Uses a dedicated accumulator (vfailed) rather than the caller's `failed`,
# because POSIX sh has no `local` and a reused global would silently reset the
# caller's aggregate status on every subsequent call.
verify_one() {
    vw="$1"
    vlabel="${2:-$(basename "$vw")}"
    vfailed=0

    if [ ! -d "$vw" ]; then
        printf 'MISSING: %s (%s)\n' "$vlabel" "$vw"
        return 1
    fi

    for vname in node_modules .yarn/cache; do
        vtarget="$vw/$vname"
        vexpected="$CANONICAL/$vname"
        if [ -L "$vtarget" ]; then
            vresolved="$(readlink "$vtarget")"
            case "$vresolved" in
                "$vexpected") printf 'OK:      %-28s -> %s\n' "$vlabel/$vname" "$vexpected" ;;
                *) printf 'DRIFT:   %-28s -> %s (expected %s)\n' "$vlabel/$vname" "$vresolved" "$vexpected"; vfailed=1 ;;
            esac
            if [ ! -e "$vtarget" ]; then
                printf 'BROKEN:  %-28s link target does not exist\n' "$vlabel/$vname"
                vfailed=1
            fi
        elif [ -e "$vtarget" ]; then
            printf 'DRIFT:   %-28s is a real path, not a symlink\n' "$vlabel/$vname"
            vfailed=1
        else
            printf 'MISSING: %-28s (no link)\n' "$vlabel/$vname"
            vfailed=1
        fi
    done

    return "$vfailed"
}

# --- Commands ---------------------------------------------------------------
cmd_add() {
    if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
        printf 'usage: %s add <branch> [base-ref]\n' "$0" >&2
        exit 2
    fi
    branch="$1"
    base="${2:-main}"

    if [ ! -d "$CANONICAL/.git" ] && [ ! -f "$CANONICAL/.git" ]; then
        printf 'ERROR: %s does not look like a git worktree\n' "$CANONICAL" >&2
        exit 1
    fi

    wt="$(worktree_dir "$branch")"
    if [ -e "$wt" ]; then
        printf 'ERROR: worktree path already exists: %s\n' "$wt" >&2
        exit 1
    fi
    if git -C "$CANONICAL" show-ref --verify --quiet "refs/heads/$branch"; then
        printf 'ERROR: branch already exists: %s\n' "$branch" >&2
        exit 1
    fi
    if ! git -C "$CANONICAL" rev-parse --verify --quiet "$base" >/dev/null; then
        printf 'ERROR: base ref does not exist: %s\n' "$base" >&2
        exit 1
    fi

    mkdir -p "$WT_ROOT"
    printf 'Creating worktree %s from %s ...\n' "$wt" "$base"
    git -C "$CANONICAL" worktree add -b "$branch" "$wt" "$base"

    printf 'Linking shared dependencies from %s ...\n' "$CANONICAL"
    if [ ! -e "$CANONICAL/node_modules" ]; then
        printf 'ERROR: canonical node_modules missing; run "yarn install" in %s first\n' "$CANONICAL" >&2
        printf 'Created worktree is still registered; clean it up with: %s remove %s\n' "$0" "$branch" >&2
        exit 1
    fi
    mkdir -p "$wt/.yarn"
    link_deps "$CANONICAL/node_modules" "$wt/node_modules" "node_modules"
    link_deps "$CANONICAL/.yarn/cache" "$wt/.yarn/cache" ".yarn/cache"
    write_marker "$wt"
    printf 'Done. Worktree: %s\n' "$wt"
    printf 'To work in it, point your agent/workspace cwd at that path (or use link-here).\n'
}

cmd_link_here() {
    wt="$(pwd -P)"
    if [ "$wt" = "$CANONICAL" ]; then
        printf 'ERROR: run link-here inside a worktree, not the canonical checkout\n' >&2
        exit 1
    fi
    if [ ! -d "$CANONICAL/node_modules" ]; then
        printf 'ERROR: canonical node_modules missing; run "yarn install" in %s first\n' "$CANONICAL" >&2
        exit 1
    fi
    printf 'Linking shared dependencies from %s into %s ...\n' "$CANONICAL" "$wt"
    mkdir -p "$wt/.yarn"
    link_deps "$CANONICAL/node_modules" "$wt/node_modules" "node_modules"
    link_deps "$CANONICAL/.yarn/cache" "$wt/.yarn/cache" ".yarn/cache"
    write_marker "$wt"
    printf 'Done.\n'
}

# Collect worktree paths into a temp file so callers can iterate without a
# pipeline subshell (which would swallow the failed flag in cmd_verify).
collect_worktrees() {
    : > "$1"
    git -C "$CANONICAL" worktree list --porcelain | sed -n 's/^worktree //p' > "$1"
}

cmd_list() {
    printf 'Canonical checkout: %s\n' "$CANONICAL"
    printf 'Worktree root:      %s\n\n' "$WT_ROOT"
    git -C "$CANONICAL" worktree list
    printf '\nDependency link health:\n'
    list_file="$(mktemp)"
    trap 'rm -f "$list_file"' EXIT HUP INT TERM
    collect_worktrees "$list_file"
    while IFS= read -r wt; do
        [ -z "$wt" ] && continue
        [ "$wt" = "$CANONICAL" ] && continue
        if verify_one "$wt" >/dev/null 2>&1; then state=OK; else state=DRIFT; fi
        printf '  %-6s %s\n' "$state" "$wt"
    done < "$list_file"
    rm -f "$list_file"
    trap - EXIT HUP INT TERM
}

cmd_verify() {
    if [ "$#" -gt 1 ]; then
        printf 'usage: %s verify [branch]\n' "$0" >&2
        exit 2
    fi
    failed=0
    if [ "$#" -eq 1 ]; then
        wt="$(worktree_dir "$1")"
        verify_one "$wt" "$1" || failed=1
    else
        list_file="$(mktemp)"
        trap 'rm -f "$list_file"' EXIT HUP INT TERM
        collect_worktrees "$list_file"
        while IFS= read -r wt; do
            [ -z "$wt" ] && continue
            [ "$wt" = "$CANONICAL" ] && continue
            verify_one "$wt" || failed=1
        done < "$list_file"
        rm -f "$list_file"
        trap - EXIT HUP INT TERM
    fi
    if [ "$failed" -ne 0 ]; then
        printf '\nSome worktrees have drifted. Fix them (remove the real path/symlink) then run link-here.\n' >&2
        exit 1
    fi
}

cmd_remove() {
    if [ "$#" -ne 1 ]; then
        printf 'usage: %s remove <branch>\n' "$0" >&2
        exit 2
    fi
    branch="$1"
    wt="$(worktree_dir "$branch")"
    if [ ! -e "$wt" ]; then
        printf 'ERROR: worktree path does not exist: %s\n' "$wt" >&2
        exit 1
    fi
    # Remove only the symlinks we created; leave anything else alone.
    for name in node_modules .yarn/cache; do
        target="$wt/$name"
        if [ -L "$target" ]; then
            expected="$CANONICAL/$name"
            if [ "$(readlink "$target")" = "$expected" ]; then
                rm "$target"
            else
                printf 'WARNING: leaving unexpected symlink %s\n' "$target" >&2
            fi
        fi
    done
    [ -f "$(marker_path "$wt")" ] && rm "$(marker_path "$wt")"
    printf 'Removing worktree %s ...\n' "$wt"
    git -C "$CANONICAL" worktree remove "$wt"
    printf 'Done. Branch %s still exists; delete with: git branch -d %s\n' "$branch" "$branch"
}

cmd_update_deps() {
    printf 'Running yarn install in canonical checkout %s ...\n' "$CANONICAL"
    (cd "$CANONICAL" && yarn install)
    printf '\nVerifying all worktree links ...\n'
    cmd_verify
}

cmd_help() {
    cat <<EOF
Usage: $0 <command> [args]

Commands:
  add <branch> [base-ref]   Create a worktree under $WT_ROOT and link shared deps.
  link-here                 In an existing worktree, link deps to the canonical checkout.
  list                      List worktrees and their dependency-link health.
  verify [branch]           Check that dependency symlinks point to the canonical checkout.
  remove <branch>           Unlink deps and remove the worktree (keeps the branch).
  update-deps               Run yarn install in the canonical checkout, then verify links.
  help                      Show this help.

Paths (derived, never hardcoded):
  canonical checkout: $CANONICAL
  worktree root:      $WT_ROOT  (override with WORKTREE_ROOT)

Worktrees share $CANONICAL/node_modules and
$CANONICAL/.yarn/cache via symlinks. Each worktree keeps its own
.yarn/install-state.gz, build outputs, and Lage cache.

Rules for agents:
  * Never run yarn install/add/remove/up in a worktree.
  * Never edit package.json or yarn.lock in a worktree.
  * Dependency changes go through 'update-deps' in the canonical checkout.
  * Use distinct PORT/E2E_PORT values if running dev servers in parallel.

See bin/WORKTREE_AGENTS.md for the full agent workflow and GitHub token rules.
EOF
}

case "${1:-help}" in
    add)         shift; cmd_add "$@" ;;
    link-here)   shift; cmd_link_here "$@" ;;
    list)        shift; cmd_list "$@" ;;
    verify)      shift; cmd_verify "$@" ;;
    remove)      shift; cmd_remove "$@" ;;
    update-deps) shift; cmd_update_deps "$@" ;;
    help|--help|-h) cmd_help ;;
    *) printf 'Unknown command: %s\n\n' "$1" >&2; cmd_help; exit 2 ;;
esac
