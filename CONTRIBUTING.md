# Contributing

Thanks for considering a contribution to SheerFlow.

## Before opening a change

1. Read the project scope and [Security Policy](SECURITY.md).
2. Keep all provider interactions within the officially documented SheerID REST API and authorized program credentials.
3. Do not add consumer-site automation, stealth, proxy rotation, CAPTCHA solving, data fabrication, document alteration, or verification-limit workarounds.
4. Do not add dependencies unless a concrete requirement cannot be met with Node.js built-ins.

## Local development

- Node.js 22.15 or newer.
- Copy `.env.example` to `.env` and configure a strong local dashboard password.
- Use `SHEERFLOW_MODE=demo` for UI and workflow development. Demo mode makes no network calls to SheerID.
- Use injected fetch implementations and local fixtures for tests. Do not run live writes from automated test suites.

## Checks

```bash
npm test
npm run check
```

Add tests for new behavior, especially error paths, cancellation, duplicate requests, and data/secret handling. Avoid assertions that require a live SheerID account.

## Pull requests

Describe the problem, the smallest change that solves it, tests performed, and any trade-offs. Never include real personal data, verification IDs, credentials, upload URLs, or provider response dumps.
