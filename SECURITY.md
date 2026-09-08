# Security policy

Taximeter never holds private keys or funds, signs a payment, or settles a
transaction. It observes payment authorizations supplied by the caller and records
upstream-reported outcomes. It does not independently verify signatures or
on-chain settlement.

## Supported version

Security fixes currently target the `0.1.0` release line. No older release line
is maintained. This policy describes support; it is not a claim that the package
has already been published or independently audited.

## Report a vulnerability privately

Use [GitHub's private vulnerability report for this repository](https://github.com/Ding808/taximeter/security/advisories/new).
Include the affected version, operating system and Node version, impact,
reproduction steps, and a minimal synthetic example. Include a suggested fix if
you have one. Do not put exploit details, payment authorizations, private data,
or credentials in a public issue.

If private reporting is unavailable, open a public issue asking the maintainer
to enable private vulnerability reporting, without disclosing the vulnerability.
Maintainers will assess the report, coordinate a fix and disclosure, and credit
the reporter with their consent. No response-time guarantee is offered.

## Trust boundary

Taximeter is a cooperative local meter. It is not an enforcement boundary
against a hostile agent or another process running as the same user.

- Unsupported or malformed payment forms pass through with a diagnostic.
  Supported parsing is narrower than the full x402 protocol; see
  [SPEC-NOTES.md](SPEC-NOTES.md).
- HTTPS CONNECT tunnels encrypted bytes without metering their payments.
  Taximeter does not install a certificate authority or intercept TLS.
- The SDK must wrap the transport inside the payment wrapper. Redirects and
  retries performed internally by that transport are not individually visible
  to the meter. The SDK therefore cannot promise host policy enforcement on
  hidden redirect hops.
- Runtime storage failures fail open to preserve the caller's traffic and emit
  a local stderr warning. Budget enforcement and ledger completeness depend on
  working storage. Investigate the "storage unavailable" warning before trusting totals.
- An agent can bypass a local proxy or SDK wrapper. Budgets do not restrict
  transfers made outside the metered path.

The services bind to loopback. The dashboard additionally checks Host and Origin,
rejects cross-site requests, and exposes a read-only API. These checks reduce
unwanted browser access; they do not authenticate local processes or replace
operating-system account isolation. Do not expose either service through a
public tunnel or reverse proxy.

## Local data

The ledger stores raw signed payment authorizations for auditability. They are
not private keys, but they can be sensitive and may remain usable under their
payment rail's rules. Treat the database, its `-wal` and `-shm` siblings, backups,
and JSON exports as sensitive local data. CSV and invoice exports omit raw
authorizations but still contain payment and attribution information.

Keep local state out of source control and avoid sharing real ledger files in
bug reports. Use synthetic fixtures and redact resource URLs and labels when
they contain private information. The dashboard event summary omits raw
authorizations, while an explicit JSON export retains the audit records.

Taximeter makes no telemetry, analytics, metadata, or balance requests. Its
runtime network activity consists of forwarding caller traffic and serving the
local dashboard. Dependency installation and release publishing are separate
development operations.
