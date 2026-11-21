#!/bin/sh
# Run a command with the Actual-only GitHub token loaded into its environment.
#
# The token lives at <parent-of-repo>/.secrets/actual-github.env, outside the
# repo so no worktree, git index, or agent can read it from disk. This wrapper
# sources that file into the environment of the child command only.
#
# Usage:
#   bin/with-actual-github.sh <command> [args...]
#   bin/with-actual-github.sh git push github main   # HTTPS git auth is automatic
#   bin/with-actual-github.sh --check          # verify setup without printing the token
#   bin/with-actual-github.sh --preamble       # print the agent safety rules
#
# Intended to be used only when launching agents whose cwd is the canonical
# checkout or one of its worktrees (under actual-worktrees). Other projects on
# this machine should not receive GITHUB_TOKEN.

set -eu

SCRIPT_PATH="$0"
case "$SCRIPT_PATH" in
    */*) ;;
    *) SCRIPT_PATH="$(command -v -- "$SCRIPT_PATH")" ;;
esac
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# Derive the secrets path from the repo location: sibling .secrets directory.
ENV_FILE="${ACTUAL_GITHUB_ENV:-$(cd "$(dirname "$REPO")" && pwd -P)/.secrets/actual-github.env}"
if [ -n "${WORKTREE_ROOT:-}" ]; then
    WT_ROOT="$(cd "$WORKTREE_ROOT" 2>/dev/null && pwd -P || printf '%s' "$WORKTREE_ROOT")"
else
    WT_ROOT="$(cd "$(dirname "$REPO")" && pwd -P)/actual-worktrees"
fi

# Token is only for the canonical checkout or its worktrees. Refuse to export
# it from any other directory so other projects on this machine never see it.
assert_scoped_cwd() {
    cwd="$(pwd -P)"
    case "$cwd" in
        "$REPO"|"$WT_ROOT"/*) ;;
        *) printf 'ERROR: GITHUB_TOKEN is scoped to %s and its worktrees; refusing to run from %s\n' "$REPO" "$cwd" >&2; exit 1 ;;
    esac
}

cmd_check() {
    if [ ! -f "$ENV_FILE" ]; then
        printf 'MISSING: %s\n' "$ENV_FILE" >&2
        exit 1
    fi
    perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || printf 'unknown')"
    printf 'env file:   %s\n' "$ENV_FILE"
    printf 'permissions:%s (want 600)\n' "$perms"
    # Check that it defines GITHUB_TOKEN without revealing the value.
    if sed -n 's/^GITHUB_TOKEN=.*/found/p' "$ENV_FILE" | grep -q found; then
        printf 'GITHUB_TOKEN is defined: yes\n'
    else
        printf 'GITHUB_TOKEN is defined: NO\n' >&2
        exit 1
    fi
    if [ "$perms" != "600" ]; then
        printf 'WARNING: permissions are not 600; run: chmod 600 %s\n' "$ENV_FILE" >&2
    fi
    printf 'Setup OK.\n'
}

# Configure non-interactive HTTPS auth for git commands. Git does not read
# GITHUB_TOKEN from the environment, so we point it at an askpass helper and
# inject the username via one-shot config (no config file is written). This is
# exported only to the child process via the surrounding `exec "$@"`.
setup_git_auth() {
    case "${1:-}" in
        git|*/git)
            export GIT_ASKPASS="$SCRIPT_DIR/git-askpass-actual.sh"
            export GIT_TERMINAL_PROMPT=0
            export GIT_CONFIG_COUNT=2
            export GIT_CONFIG_KEY_0='credential.https://github.com.username'
            export GIT_CONFIG_VALUE_0='x-access-token'
            # Clear any pre-existing credential helper so a stale cached
            # credential cannot preempt the token path on other machines.
            export GIT_CONFIG_KEY_1='credential.helper'
            export GIT_CONFIG_VALUE_1=''
            ;;
    esac
}

cmd_preamble() {
    cat <<'EOF'
GitHub access rules for agents on the `actual` repo:

  * A GITHUB_TOKEN is available in the environment. NEVER print, echo, log, or
    write its value to any file, commit message, PR body, comment, or tool
    call. Never include it in code, config, or documentation.
  * Use GitHub tools/CLI commands (gh, MCP github tools) that read the token
    from the environment implicitly. Do not pass the token as an argument.
  * Only operate on the `actual` repository (actualbudget/actual) and its worktrees.
    Do not use this token for any other repository or purpose.
  * Before creating a PR, check for a pull request template in the repo and
    follow all repo rules for [AI]-prefixed titles and blank PR templates.
EOF
}

case "${1:-}" in
    --check)
        cmd_check
        ;;
    --preamble)
        cmd_preamble
        ;;
    --help|-h|help)
        printf 'usage: %s --check | --preamble | <command> [args...]\n' "$0"
        ;;
    "")
        printf 'usage: %s --check | --preamble | <command> [args...]\n' "$0" >&2
        exit 2
        ;;
    *)
        assert_scoped_cwd
        if [ ! -f "$ENV_FILE" ]; then
            printf 'ERROR: env file not found: %s\n' "$ENV_FILE" >&2
            exit 1
        fi
        # Load the env file into this shell, then export all its variables.
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        setup_git_auth "$@"
        exec "$@"
        ;;
esac
