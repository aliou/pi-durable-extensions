# pi-durable extensions

Each package in this workspace is installed in a pi-durable Harness registry. None of them is a Pi coding-agent extension: do not add Pi coding-agent discovery metadata or installation instructions.

Extensions persist state that outlives code changes, so careless edits lose stored conversations or repeat external effects.

## Checks

Run from the repository root inside `nix develop`. Build before typechecking: packages consume each other's generated declarations.

`pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## Invariants

- Store inbound work durably before acknowledging it. Outbound effects are at least once: keep idempotency keys stable across retries and recovery.
- Extension, registration, document, task, and entry names are persisted identifiers. Changing their shape needs a version bump and a migrate function.

## Conventions

- A package adds a document, entry, task, or extension name only after checking it does not collide with pi-durable's own (`pi.*`) or another installed extension's.
