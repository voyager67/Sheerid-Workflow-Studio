# Security Policy

## Supported use

SheerFlow is intended for authorized integrations with a SheerID program and API application. Do not use it to misrepresent eligibility, submit another person's data without authorization, fabricate or alter evidence, bypass verification steps, or interact with provider websites contrary to their terms.

## Reporting a vulnerability

Do not open a public issue containing exploitable details, real verification IDs, access tokens, secrets, personal information, document bytes, or signed upload URLs. Contact the repository maintainer privately through GitHub's security advisory feature after the repository is published.

## Local secrets and data

- Keep credentials in a local `.env` file. Never commit it.
- Only `.env.example` may be committed.
- Rotate any credential that may have been exposed.
- Use provider Test Mode and fictional test subjects for integration checks.
- Do not attach production documents, request/response dumps, personal information, or signed upload URLs to issues or pull requests.
- The dashboard is intended for loopback use. Do not expose it directly to the public internet.

## Supported reports

Please include the affected version, Node.js version, a minimal reproduction using fictional data, expected behavior, and observed behavior. Remove all credentials and subject data before submitting.
