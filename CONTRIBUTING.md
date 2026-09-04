# Contributing

Focused issues and pull requests are welcome.

1. Describe the safety property or failure mode before changing behavior.
2. Keep agent proposals separate from authorization and execution.
3. Add or update a test that fails without the change.
4. Use synthetic data only.
5. Run `npm run verify` before opening a pull request.

For changes to policy semantics, include the old and new precedence, the affected event sequence, the fail-closed behavior, and any migration concern for in-flight runs. For storage adapters, document transaction boundaries, concurrency behavior, idempotency durability, and recovery after partial failure.

Security reports belong in GitHub’s private vulnerability-reporting flow rather than a public issue.
