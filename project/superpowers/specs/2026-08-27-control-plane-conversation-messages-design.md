# Control-plane conversation message gate

## Decision

Keep the work-item conversation timeline readable, but make control-plane
message creation an explicit opt-in. Add
`surfaces.api.conversationMessages.enabled`, defaulting to `false`.

## Rationale

The current control-plane command has no trusted per-operator identity at the
application boundary. With the command enabled, entries would therefore carry
the generic `web` actor identifier. Until authenticated session identity is
propagated through that boundary, Wake should not offer a write path that
appears to attribute a message to a particular operator.

## Behaviour

- The `GET` work-detail response continues to include the canonical
  conversation timeline regardless of this setting.
- When disabled (including when the setting is omitted), Bootstrap does not
  expose the `message` work application capability. The existing API command
  route consequently returns its standard `command-unavailable` response and
  cannot create conversation entries or resume workflow stages.
- When explicitly enabled, the existing command records the entry and runs the
  normal resume bridge unchanged.
- This is an API capability setting because the command is exposed through the
  API whether it is invoked by the web control plane or another local client.
  A future UI composer must use this same capability rather than adding a
  separate flag.

## Scope and follow-up

This change is a safety gate, not an identity implementation. Proper
per-operator attribution remains a follow-up: authenticated session identity
must flow from the HTTP surface to the work application, without accepting an
arbitrary actor identifier in a request body.

## Verification

Configuration parsing covers the default and explicit enablement. Surface
application/API tests prove that the default omits the command and that the
explicit setting retains its existing behaviour. Current configuration
documentation and the generated Wake-home example document the opt-in.
