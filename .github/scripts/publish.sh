#!/usr/bin/env bash
set -euo pipefail

# Changesets calls this only when it reaches publishing, so version PRs can
# still be prepared without npm credentials. The action configures npm auth.
if [[ -z "${NPM_TOKEN:-}" ]]; then
  printf '%s\n' '::error title=Missing npm publishing token::Add an Actions repository secret named NPM_TOKEN with an npm granular publishing token. See CONTRIBUTING.md#npm-publishing-credentials.'
  exit 1
fi

if ! npm whoami --registry=https://registry.npmjs.org/ >/dev/null 2>&1; then
  printf '%s\n' '::error title=npm authentication check failed::Check that NPM_TOKEN is valid, unexpired, available to this repository, and accepted by registry.npmjs.org. A registry or network failure can also prevent this check.'
  exit 1
fi

npm run release
