# Architecture

## Overview

SheerFlow has three boundaries:

1. **Browser UI** — renders the operator dashboard and sends local JSON/binary requests to the loopback server. It never receives OAuth client secrets or bearer tokens.
2. **Local orchestration server** — authenticates the operator, validates payloads, manages the in-memory queue, applies concurrency limits, handles cancellation, and records redacted event messages.
3. **Provider adapter** — `SheerIDClient` talks to the documented REST API. `OAuthTokenManager` obtains and caches dynamic bearer tokens. Signed document uploads use the exact URL returned by the provider and do not receive the OAuth bearer token.

## Workflow lifecycle

```text
QUEUED
  └─ RUNNING
      ├─ APPROVED       provider currentStep = success
      ├─ REJECTED       provider currentStep = error or terminal errorIds
      ├─ NEEDS_DOCUMENT provider currentStep = docUpload
      │    └─ UPLOADING → WAITING (or provider's next state)
      ├─ WAITING        provider currentStep = pending; status is polled
      ├─ ACTION_REQUIRED emailLoop / sso / another provider-directed step
      ├─ UNKNOWN        write outcome could not be confirmed; no automatic replay
      └─ FAILED         local or provider API error
```

The queue creates a provider verification only once per local request ID during the process lifetime. Creation and submission requests are non-idempotent. If a write's response is lost, SheerFlow records an uncertain outcome and does not replay the write. The operator must reconcile it before attempting another verification.

## Data lifecycle

- Subject JSON is accepted into memory, validated, sent only to the configured provider program, and cleared after submission.
- Job events contain state names and operator-readable messages, not subject fields or document names.
- Documents are checked by file signature and size, retained in memory for the upload, sent to the returned signed URL, then zeroed in the application buffer.
- OAuth client credentials and access tokens stay-server-side.
- No job, personal data, document, token, or session is persisted to disk.

## Demo adapter

`MockSheerIDClient` implements the same adapter contract for a visible, local demonstration. It is selected only when `SHEERFLOW_MODE=demo`. Live mode selects `SheerIDClient`. The mock adapter has no network capability and is not used by the live client.
