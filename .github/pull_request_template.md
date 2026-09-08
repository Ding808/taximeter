## Change

Describe the concrete problem and the resulting behavior. Link the issue if one exists.

## Validation

List the commands and behavioral checks you actually ran, with their results.
Explain any untested path or known limitation.

## Review notes

Describe compatibility changes, protocol evidence, or tradeoffs a reviewer needs
to assess. Explain intentional golden snapshot changes.

- [ ] Monetary amounts remain integer strings and use exact arithmetic.
- [ ] Unknown traffic remains transparent, and relevant failure/retry tests pass.
- [ ] External inputs are validated; no keys, custody, or extra runtime network calls were added.
- [ ] Documentation and a changeset are included where behavior changes.
- [ ] Generated output and local data are excluded from the change.
