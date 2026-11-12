# SheerID API Workflow Notes

SheerFlow follows the current official REST API tutorial and authentication documentation. Provider payload schemas vary by segment and program. The dashboard accepts a JSON object so the operator can supply the exact supported schema for their own program.

## Authentication

The live adapter obtains a dynamic OAuth token using the Client Credentials grant:

- `POST https://auth.sheerid.com/oauth/token`
- `grant_type=client_credentials`
- `audience=https://services.sheerid.com/rest/`
- `client_id` and `client_secret` from server environment variables

The token is cached in memory and refreshed before its expiry. A status GET receiving `401` triggers one token refresh and one safe retry. The secret and access token are never sent to the browser.

## Create and submit

1. `POST https://services.sheerid.com/rest/v2/verification` with `{"programId":"..."}`.
2. Validate the returned 24-character `verificationId`, `currentStep`, `errorIds`, and provider `submissionUrl`.
3. If the provider requests a supported `collect...PersonalInfo` step, POST the operator-supplied segment payload to the exact returned URL after validating its origin and verification ID.

For student programs, the official quickstart shows `firstName`, `lastName`, `birthDate`, `email`, and `organization` with the actual provider organization ID/name. SheerFlow reads the program theme's `config.orgSearchUrl` and uses the provider organization-search service to find supported organizations. Other segments may require different data. Do not guess provider IDs or invent fields.

## Document upload

When the provider returns `currentStep: docUpload`:

1. Validate one to five selected files (PDF, PNG, or JPEG) and the combined local size limit.
2. POST a JSON `files` array to `/verification/{verificationId}/step/docUpload` with each file's `fileName`, `mimeType`, and `fileSize`.
3. Confirm the provider returns one upload record per file.
4. PUT each original file byte buffer to the corresponding signed `uploadUrl`. Use the exact URL; do not forward the OAuth bearer token to the storage service.
5. POST an empty body to the returned `completeDocUpload` submission URL.
6. Poll the verification status until the provider reports a terminal outcome or another action is required.

The implementation does not edit, generate, enhance, or fabricate document contents. It validates the file signature, extension and size only; it does not assess document authenticity.

## Polling and errors

- `pending` remains non-terminal and is polled at the configured interval.
- `success` and `error` are terminal provider steps; `rewardData` is surfaced only for a successful verification.
- `emailLoop`, `sso`, and unsupported manual steps are surfaced as action-required states instead of being bypassed.
- Recoverable personal-information errors leave the same `verificationId` on its existing collect step and can be corrected/resubmitted. `sourcesUnavailable`, `dataProviderError`, and `dataNotAvailable` are retried twice with bounded backoff on that same step.
- Retry a 429 only when SheerID explicitly returns `apiRateLimitExceeded`; use bounded exponential backoff. Safe status GETs may retry transient 5xx responses. Program/person limits are terminal. A write that times out without a definitive response is marked unknown and is not replayed.
- Non-idempotent POST and signed-upload writes are never automatically replayed after an ambiguous outcome.
- **Stop local tracking** only stops this application's polling or queued work. It does not cancel a verification already created at SheerID. Jobs with a known provider ID can be refreshed later; a job whose create request has an unknown outcome must be reconciled with the program operator before another verification is started.

## Test Mode

SheerID Test Mode is a program configuration in MySheerID. Configure it with your account administrator before using live API mode for test transactions. `SHEERFLOW_MODE=demo` is a separate local mock and does not alter the provider program's Test Mode setting.
