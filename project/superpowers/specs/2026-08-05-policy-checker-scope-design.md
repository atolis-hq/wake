# Policy Checker Scope Design

## Goal

Restore `verify:next` by correcting false-positive vocabulary checks while preserving the architectural constraints they enforce.

## Scope

The provider-locality rule will continue to reject concrete provider names in production identifiers outside the provider namespace. It will stop treating ordinary string and template literals as provider references. This permits operational Dockerfile content, URLs, and user-facing CLI copy to name the GitHub service without weakening code-level provider locality.

The web transport decoder will use a shared `ResourceItemField.Adapter` field key rather than repeating the registered `"adapter"` literal when decoding a resource response.

## Components

- `scripts/lib/provider-locality-rule.mjs`: visit identifiers only for path-scope diagnostics; retain the existing value-scope checks inside provider namespaces.
- `test-next/architecture/`: add coverage showing operational literals are permitted and provider-named identifiers outside an integration are rejected.
- `src-next/surfaces/api/contracts/transport-values.ts`: export `ResourceItemField.Adapter`.
- `src-next/surfaces/web/src/api/decoders.ts`: reference the shared field value for both lookup and error-path construction.
- `src-next/surfaces/web/test/`: add coverage for the decoder's unchanged `adapter` decoding behavior.

## Error Handling and Verification

No runtime behavior changes. Architecture tests prove the checker boundary, while the web decoder test proves the API response still accepts an adapter value. The focused tests run during development, followed by `npm run verify:next`.

## Non-goals

- Do not rename GitHub-facing prompts, URLs, Dockerfile package sources, or CLI commands.
- Do not create exceptions for a particular provider or file path.
- Do not change the API response shape.
