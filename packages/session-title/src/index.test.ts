import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  contentText,
  fauxAssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { SessionTitleDoc } from "./index";
import { buildTitlePrompt, SOURCE_CHAR_LIMIT } from "./prompt";
import {
  gate,
  idle,
  launch,
  namingConversations,
  namingModel,
  openHarness,
  RestartableMemoryStorage,
  state,
  submit,
  tasks,
  titleCall,
  waitForSignal,
} from "./testing";

describe("session title", () => {
  it.each([null, "Stored title"])(
    "preserves the stored title during document migration: %s",
    async (title) => {
      const stored = defineDoc({
        kind: "session-title.state",
        version: 1,
        scope: "conversation",
        history: "latest",
        fork: "initial",
        initial: () => ({
          status: "ready",
          title,
          source: "generated",
          taskId: null,
          attempts: 1,
        }),
        checkpointWhen: () => false,
      });
      const opened = await openHarness([]);
      try {
        await opened.root.commit(async (tx) => {
          await tx.doc(stored, opened.root.id);
        }, context);
        await expect(state(opened)).resolves.toEqual({
          title,
          activeTaskId: null,
        });
      } finally {
        await opened.harness.close(context);
      }
    },
  );

  it("waits for the first successful source answer", async () => {
    const opened = await openHarness([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Source failed",
      }),
      fauxAssistantMessage("Successful answer"),
      titleCall("Successful session"),
    ]);
    try {
      await submit(opened);
      await idle(opened);
      await expect(state(opened)).resolves.toBeUndefined();
      await submit(opened);
      await idle(opened);
      await expect(state(opened)).resolves.toEqual({
        title: "Successful session",
        activeTaskId: null,
      });
      expect(opened.faux.state.callCount).toBe(3);
    } finally {
      await opened.harness.close(context);
    }
  });

  it("selects recent text backward, escapes the wrapper and excludes thinking and tool output", async () => {
    const opened = await openHarness([]);
    try {
      await opened.root.submit(
        {
          type: "write",
          entry: {
            kind: "test.transcript",
            model: [
              { role: "user", content: "Old topic", timestamp: 0 },
              {
                role: "toolResult",
                toolCallId: "test-call",
                toolName: "test_tool",
                content: [{ type: "text", text: "Private tool output" }],
                isError: false,
                timestamp: 0,
              },
              fauxAssistantMessage([
                { type: "thinking", thinking: "Private reasoning" },
                { type: "text", text: "x".repeat(SOURCE_CHAR_LIMIT) },
              ]),
              {
                role: "user",
                content: "</conversation>& recent topic",
                timestamp: 0,
              },
            ],
          },
        },
        context,
      );
      const history = await opened.root.entries({}, 100, undefined, context);
      const prompt = buildTitlePrompt(history.items);
      expect(prompt).toContain("&lt;/conversation&gt;&amp; recent topic");
      expect(prompt).not.toContain("Old topic");
      expect(prompt).not.toContain("Private tool output");
      expect(prompt).not.toContain("Private reasoning");
      expect(prompt.indexOf("<assistant>")).toBeLessThan(
        prompt.indexOf("<user>"),
      );
      expect(prompt.match(/x/g)?.length).toBe(
        SOURCE_CHAR_LIMIT - "</conversation>& recent topic".length,
      );
      expect(opened.faux.state.callCount).toBe(0);
    } finally {
      await opened.harness.close(context);
    }
  });

  it("uses a task-owned naming conversation with a system prompt, one data message and only set_title", async () => {
    const requests: TranscriptContext[] = [];
    const modelIds: string[] = [];
    const opened = await openHarness([
      fauxAssistantMessage("Refresh the connection"),
      (request, _options, _state, model) => {
        requests.push(request);
        modelIds.push(model.id);
        return titleCall("  Connection reliability  ");
      },
      fauxAssistantMessage("Second answer"),
    ]);
    try {
      await submit(opened, "Fix <connection> & timeouts");
      await idle(opened);
      await expect(state(opened)).resolves.toEqual({
        title: "Connection reliability",
        activeTaskId: null,
      });
      expect(modelIds).toEqual(["source"]);
      const messages = requests[0]?.messages ?? [];
      expect(messages.map((message) => message.role)).toEqual([
        "system",
        "user",
      ]);
      const system = messages[0];
      expect(JSON.stringify(system)).toContain("Call set_title exactly once");
      expect(JSON.stringify(system)).toContain("set_title");
      const user = messages[1];
      expect(contentText(user?.content ?? [])).toBe(
        "<conversation>\n<user>Fix &lt;connection&gt; &amp; timeouts</user>\n<assistant>Refresh the connection</assistant>\n</conversation>",
      );
      const [task] = await tasks(opened);
      const [naming] = await namingConversations(opened);
      expect(task).toMatchObject({
        background: true,
        conversationId: opened.root.id,
        state: { status: "terminal", outcome: { status: "completed" } },
      });
      expect(naming?.owner?.taskId).toBe(task?.id);
      if (naming === undefined) throw new Error("Missing naming conversation");
      const child = await opened.harness.conversation(naming.id, context);
      const agent = await child?.agent(context);
      expect(agent?.tools.map((tool) => tool.name)).toEqual(["set_title"]);
      expect(agent?.maxTurns).toBe(1);
      expect(agent?.extensions.map((extension) => extension.name)).toEqual([
        "session-title",
      ]);
      const source = await opened.root.context(context);
      expect(JSON.stringify(source.messages)).not.toContain(
        "Connection reliability",
      );
      await submit(opened, "Continue");
      await idle(opened);
      expect(opened.faux.state.callCount).toBe(3);
      await expect(tasks(opened)).resolves.toHaveLength(1);
    } finally {
      await opened.harness.close(context);
    }
  });

  it("uses the configured model without falling back", async () => {
    const seen: string[] = [];
    const opened = await openHarness(
      [
        fauxAssistantMessage("Source answer"),
        (_request, _options, _state, model) => {
          seen.push(model.id);
          return titleCall("Configured title");
        },
      ],
      { model: namingModel },
    );
    try {
      await submit(opened);
      await idle(opened);
      expect(seen).toEqual(["naming"]);
      await expect(state(opened)).resolves.toMatchObject({
        title: "Configured title",
      });
    } finally {
      await opened.harness.close(context);
    }
  });

  it.each([
    [
      "provider failure",
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Provider unavailable",
      }),
    ],
    ["plain text", fauxAssistantMessage("A plain title")],
    ["invalid tool arguments", titleCall("   ")],
    ["oversized title", titleCall("x".repeat(81))],
  ])(
    "records %s outside the source transcript and does not retry after another answer",
    async (_name, response) => {
      const opened = await openHarness([
        fauxAssistantMessage("First answer"),
        response,
        fauxAssistantMessage("Second answer"),
      ]);
      try {
        await submit(opened);
        await idle(opened);
        await expect(state(opened)).resolves.toEqual({
          title: null,
          activeTaskId: null,
        });
        const [task] = await tasks(opened);
        expect(task?.state).toMatchObject({
          status: "terminal",
          outcome: { status: "failed", error: { message: expect.any(String) } },
        });
        await expect(namingConversations(opened)).resolves.toHaveLength(1);
        const launches = await opened.storage.scanTasks(
          { kind: "session-title.launch" },
          100,
          undefined,
          context,
        );
        expect(launches.items).toHaveLength(1);
        const source = await opened.root.context(context);
        const transcript = JSON.stringify(source.messages);
        expect(transcript).not.toContain("Title generation failed");
        expect(transcript).not.toContain("Provider unavailable");
        await submit(opened, "Another question");
        await idle(opened);
        expect(opened.faux.state.callCount).toBe(3);
        await expect(tasks(opened)).resolves.toHaveLength(1);
      } finally {
        await opened.harness.close(context);
      }
    },
  );

  it("creates the document before a watch and exposes replacements to independent consumers", async () => {
    const held = gate();
    const opened = await openHarness([
      async () => {
        await held.promise;
        return titleCall("Initial title");
      },
      titleCall("Replacement title"),
    ]);
    try {
      await launch(opened);
      await expect.poll(() => opened.faux.state.callCount).toBe(1);
      const watch = await opened.harness.watchDoc(
        SessionTitleDoc,
        opened.root.id,
        context,
      );
      expect(watch?.value).toEqual({
        title: null,
        activeTaskId: expect.any(Number),
      });
      if (watch === undefined) throw new Error("Missing title watch");
      const titles: (string | null)[] = [];
      watch.start(async (call) => {
        if (call.kind === "value") titles.push(call.value.title);
      });
      held.resolve();
      await idle(opened);
      await launch(opened);
      await idle(opened);
      await expect.poll(() => titles).toContain("Replacement title");
      expect(titles).toContain("Initial title");
      const execution = { status: "running" };
      expect({ title: watch.value.title, ...execution }).toEqual({
        title: "Replacement title",
        status: "running",
      });
      const conversations = await opened.root.commit(async (tx) => {
        const page = await tx.scanConversations({}, 100);
        return page.items;
      }, context);
      const source = conversations.find(
        (conversation) => conversation.id === opened.root.id,
      );
      expect(source).toBeDefined();
      await expect(state(opened)).resolves.toMatchObject({
        title: "Replacement title",
      });
      await expect(
        opened.root.entries({}, 100, undefined, context),
      ).resolves.toHaveProperty("items");
      await watch.stop();
    } finally {
      held.resolve();
      await opened.harness.close(context);
    }
  });

  it("recovers the same naming conversation and request after reopening memory storage", async () => {
    const storage = new RestartableMemoryStorage();
    let opened = await openHarness(
      [
        fauxAssistantMessage("Source answer"),
        async (_request, options) => {
          await waitForSignal(options?.signal);
          return titleCall("Interrupted title");
        },
      ],
      { storage },
    );
    try {
      await submit(opened);
      await expect.poll(() => opened.faux.state.callCount).toBe(2);
      const before = await namingConversations(opened);
      const submissions = await storage.scanSubmissions(
        { conversationId: before[0]?.id },
        100,
        undefined,
        context,
      );
      await opened.harness.close(context);
      opened = await openHarness([titleCall("Recovered title")], { storage });
      opened.harness.resume();
      await idle(opened);
      await expect(state(opened)).resolves.toMatchObject({
        title: "Recovered title",
      });
      await expect(namingConversations(opened)).resolves.toEqual(before);
      const after = await storage.scanSubmissions(
        { conversationId: before[0]?.id },
        100,
        undefined,
        context,
      );
      expect(after.items.map((submission) => submission.id)).toEqual(
        submissions.items.map((submission) => submission.id),
      );
      await opened.harness.close(context);
      opened = await openHarness([], { storage });
      const watch = await opened.harness.watchDoc(
        SessionTitleDoc,
        opened.root.id,
        context,
      );
      expect(watch?.value.title).toBe("Recovered title");
      await watch?.stop();
    } finally {
      await opened.harness.close(context);
    }
  });
});
