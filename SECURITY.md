# Security policy

## Supported versions

Synode is a research reference implementation. Security fixes are applied to the current `main` branch; no long-term-support release line is promised.

## Reporting a vulnerability

Use GitHub’s **Report a vulnerability** flow in the repository Security tab. Please include the affected component, impact, reproduction steps using synthetic data, and a suggested mitigation when available.

Do not open a public issue for a suspected vulnerability and do not submit secrets, customer information, credentials, or evidence from a live system.

## Scope

Reports about tenant isolation, approval bypass, policy precedence, idempotency conflicts, event-chain integrity, unsafe static-content rendering, dependency compromise, or path traversal are especially useful. The documented limitations of the in-memory research adapters are not vulnerabilities unless the implementation behaves differently from the stated boundary.
