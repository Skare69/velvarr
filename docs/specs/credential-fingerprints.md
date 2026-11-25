# Credential fingerprints

## Behavior

API credentials need opaque tags for cache identity and guarded credential clears.
These tags do not store or verify user passwords.

Encode the key as UTF-16LE to preserve each JavaScript code unit.
Include its code-unit length in the message to separate keys that HMAC otherwise zero-pads to the same bytes.
Use HMAC-SHA-256 with the API credential as the key.
Use a random 32-byte process nonce and a purpose string as the message.
Never persist or expose the nonce.
Never log a credential or its tag.

The same credential and purpose produce the same tag within one process.
Different credentials, purposes, or processes produce independent tags.
The judgment identity includes the backend provider, URL, and model.
The metadata cache includes the service, method, URL, request body, and credential tag.

## Boundaries and errors

The administrator receives only an opaque 32-character hexadecimal `keyFingerprint`.
The client echoes it in the existing `<field>Expect` field.
A guarded clear deletes a stored credential only when that credential matches the fingerprint.
If no stored credential exists, a guarded clear remains a no-op.
If a stored credential does not match, the server returns `provider_key_mismatch` with HTTP 409.
An absent fingerprint never permits automatic deletion.
Manual clear behavior does not change.

Tags change after a process restart.
A pending clear from an older process requires a new connection check.
The same safe refusal applies across different server processes.
Caches remain in memory, so no persistent migration is necessary.
No route, field, environment value, or stored credential changes.

## Acceptance checks

- Prove fingerprint stability within one process and isolation between two processes.
- Preserve the 32-character guard format and reject a legacy SHA-256 fingerprint.
- Preserve the existing guard properties for matching and replaced credentials.
- Prove distinct credentials do not share metadata, including a former FNV collision.
- Prove judgment memo and failure gates remain separate across backend settings and credentials.
- Run format, type checks, all unit and API tests, and the production build.
- Check both reported locations against the CodeQL sink model.

## Non-goals

- User password storage or a new password hashing scheme.
- Authentication, sessions, CSRF, admission, or storage encryption.
- New dependencies, persistent secrets, or deployment settings.
- GitHub alert dismissal, reopening, or manual closure.

## Risks

A request that reaches another process can receive a guard mismatch.
This refusal preserves the stored credential and requires a fresh check.
Human security review remains necessary before release.
