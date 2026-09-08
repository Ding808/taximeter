---
name: Bug report
about: Report incorrect behavior with a reproducible example.
title: ""
labels: ""
assignees: ""
---

Please report security vulnerabilities privately using
[SECURITY.md](https://github.com/Ding808/taximeter/blob/main/SECURITY.md).
Do not attach real payment authorizations, private keys, credentials, or ledger files.

## Problem

Describe what happened, what you expected, and how it affected your agent.

## Reproduce

Provide the smallest commands or synthetic example that demonstrates the issue.
Include relevant configuration with private information removed.

## Environment

- Taximeter version:
- Node.js version:
- Operating system:
- Entry point: HTTP proxy, explicit upstream, SDK, CLI, or dashboard:
- Payment protocol/version, if relevant:

## Evidence

Include sanitized output or diagnostics. For an accounting issue, give the
expected and actual amounts as integer strings, with network and asset identity.
For a traffic issue, describe the method, encoding, status, and bytes that changed.

## Checks

- [ ] I checked whether the payment form is supported in `SPEC-NOTES.md`.
- [ ] I removed authorizations, credentials, and private information from this report.
