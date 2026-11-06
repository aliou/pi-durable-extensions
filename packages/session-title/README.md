# @aliou/pi-durable-session-title

Generates a short title after a conversation's first successful answer. A background task runs a separate naming conversation whose only model-callable tool is `set_title`. The transcript, model request, tool call, and title state use pi-durable's normal recovery.

## Usage

Requires Node 24+ and pi-durable 1.5.0.

```sh
pnpm add @aliou/pi-durable-session-title @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 @earendil-works/chord@1.5.0
```

```js
import { SessionTitle, SessionTitleDoc } from "@aliou/pi-durable-session-title";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const registry = createRegistry();
registry.install(SessionTitle);
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, {
  agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } },
});

await (await root.submit({ type: "input", content: "Fix the login timeout" }, context)).wait(context);
const state = await harness.snapshot(SessionTitleDoc, root.id, context);
console.log(state?.title);
```

The submission can finish before the background title task. Watch `SessionTitleDoc` or poll `harness.snapshot()` when the host needs to wait for the title.

Use the conversation model by default, or configure a different naming model:

```js
import { createSessionTitleExtension } from "@aliou/pi-durable-session-title";

registry.install(createSessionTitleExtension({
  model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
}));
```

If the configured naming model fails, the extension retries once with the conversation model. Other failed naming attempts leave the state idle and retry after the next successful main answer.

## Naming instructions

Use `systemPrompt` to replace the default naming instructions. Use `appendSystemPrompt` to add instructions after the default prompt or after a replacement supplied in `systemPrompt`.

```js
registry.install(createSessionTitleExtension({
  appendSystemPrompt: "Use sentence case and include the project name when it is clear.",
}));
```

## Manual titles

Call `setSessionTitle()` when the user names a conversation. Manual titles prevent automatic generation and win races with an in-flight naming task.

```js
import { setSessionTitle } from "@aliou/pi-durable-session-title";

await setSessionTitle(root, "Login reliability", context);
```

Titles must contain non-whitespace text and fit within 80 characters after trimming. `SessionTitleDoc` records the title, its generated or manual source, generation status, current task, and attempt count. It starts empty on a fork.
