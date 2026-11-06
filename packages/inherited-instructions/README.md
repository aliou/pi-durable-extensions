# @aliou/pi-durable-inherited-instructions

Loads the context files of the conversation's working directory and each of its ancestors, up to the file system root, and renders them as a `project_instructions` system prompt section. Reproduces the Pi coding agent's `AGENTS.md` handling:

- Each directory's first matching file wins: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`. Other names, such as `CLAUDE.md`, are ignored unless you pass custom `candidates`.
- Files render root-most first, working directory last, each wrapped in `<project_instructions path="...">` under a shared header, so a closer file can refine what a farther one set up.
- A byte-order mark is stripped; directories that share a candidate name are skipped.

The section reads through the conversation's `ExecutionEnv` file system. That file system resolves paths against the conversation's cwd without being confined to it, so the walk covers the real file system the working directory lives in — including when the environment runs in a container. The section re-renders before each request; because pi-durable diffs sections, a changed file only appends the difference.

## Usage

Requires Node 24+ and pi-durable 1.5.0.

```sh
pnpm add @aliou/pi-durable-inherited-instructions @earendil-works/pi-durable@1.5.0 @earendil-works/chord@1.5.0
```

```js
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { InheritedInstructions } from "@aliou/pi-durable-inherited-instructions";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const registry = createRegistry();
registry.install(InheritedInstructions);
const harness = await Harness.open(storage, {
  models,
  registry,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd }),
}, context);
const root = await harness.root(context, {
  agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, cwd: "/repo" },
});
```

## Extra files

Pass `extraFiles` to add files outside the working directory's ancestor chain, such as a global instructions file. Each file carries its own position: it renders with the same `<project_instructions path="...">` blocks, either before the inherited files (`"prepend"`) or after them (`"append"`, the default):

```js
import { homedir } from "node:os";
import { createInheritedInstructionsExtension } from "@aliou/pi-durable-inherited-instructions";

registry.install(createInheritedInstructionsExtension({
  extraFiles: [
    { path: join(homedir(), ".pi", "agent", "AGENTS.md"), position: "prepend" },
    { path: "/shared/style-guide.md" },
  ],
}));
```

Missing extra files are skipped. An extra file the walk also finds renders once, at its configured position. Configure different candidate names or header text with `candidates` and `header`.

Without an environment (`HarnessOptions.env` unset, or a conversation without a cwd) the section renders nothing instead of failing.
