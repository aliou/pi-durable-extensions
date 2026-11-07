# @aliou/pi-durable-session-title

Generate a durable conversation title after the first successful agent answer. Read the latest title or follow changes through `SessionTitleDoc`.

## Usage

Install the package in a pi-durable Harness registry. The host supplies models, providers, and credentials.

```ts
import {
  createSessionTitleExtension,
  SessionTitleDoc,
} from "@aliou/pi-durable-session-title";

registry.install(createSessionTitleExtension());
```

The naming conversation uses the source conversation's model. Pass `{ model }` to select a different titling model.

```ts
const state = await harness.snapshot(SessionTitleDoc, conversation.id, context);
console.log(state?.title);

const watch = await harness.watchDoc(SessionTitleDoc, conversation.id, context);
if (watch !== undefined) {
  console.log(watch.value.title);
  watch.start(async (call) => {
    if (call.kind === "value") console.log(call.value.title);
  });
}
```

The document must exist before attaching a watch. Scheduling creates it. Hosts that need a watch before the first answer can create it with `tx.doc(SessionTitleDoc, conversation.id)` in their conversation-creation transaction.

## Behavior

- `SessionTitleState` contains `{ title: string | null, activeTaskId: TaskId | null }`.
- The title stays visible while a replacement is generated. Only the active task may change it.
- A background task owns a separate naming conversation with one embedded-transcript user message and only the `set_title` tool.
- The transcript includes recent user and assistant text in chronological order, selected backward within an 8,000-character budget and a 100-entry window. XML metacharacters are escaped. Tool output, thinking, and non-text content are excluded.
- Titles contain non-whitespace text and at most 80 characters after trimming.
- The extension submits one naming request with a stable task-derived request ID. It uses the host's generation defaults and does not choose fallback models.
- Failures preserve the title and record a failed task outcome. The naming conversation and submission remain available for inspection. No announcement or error is added to the source transcript.
- Automatic scheduling runs only after the first successful agent answer. Later answers do not trigger generation, including after a naming failure. The task flow supports replacing an existing title without changing this scheduling policy.
- Recovery reuses the task-owned naming conversation and its submission. The document keeps only its latest value and starts empty on forks.

Consumers can combine the title with their own execution state or stored transcripts. This extension does not report protocols, search, or index conversations.
