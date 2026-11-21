#!/bin/sh
# Git askpass helper for HTTPS GitHub operations.
#
# Git invokes this program from GIT_ASKPASS when it needs credentials for an
# HTTPS remote. It reads $GITHUB_TOKEN from the environment (injected by
# bin/with-actual-github.sh) and answers git's username/password prompts:
#
#   Username for 'https://github.com':  -> x-access-token
#   Password for 'https://github.com':  -> the token
#
# The token is printed only to git's credential pipe; it is never written to
# disk, argv, or a config file.

set -eu

if [ -z "${GITHUB_TOKEN:-}" ]; then
    printf 'ERROR: GITHUB_TOKEN is not set\n' >&2
    exit 1
fi

# Only answer prompts whose URL authority is exactly github.com. Git includes
# the remote URL in the prompt (e.g. "Password for 'https://github.com':").
# Parse the authority out, strip any userinfo and port, and require an exact
# match so lookalike hosts (notgithub.com, github.com@evil.example) never get
# the token. Fail closed if no URL can be parsed.
prompt="${1:-}"
authority=$(printf '%s' "$prompt" | sed -n "s|.*://\([^/']*\).*|\1|p")
host="${authority##*@}"
host="${host%%:*}"
if [ "$host" != "github.com" ]; then
    printf ''
    exit 0
fi
case "$prompt" in
    *Username*|*username*) printf 'x-access-token\n' ;;
    *Password*|*password*) printf '%s\n' "$GITHUB_TOKEN" ;;
    *) printf '' ;;
esac
