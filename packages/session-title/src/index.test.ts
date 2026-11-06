import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  createSessionTitleExtension,
  SessionTitle,
  SessionTitleDoc,
  type SessionTitleOptions,
  type SessionTitleState,
  setSessionTitle,
} from "./index";

const mainModel = { provider: "faux", modelId: "main" };
const smallModel = { provider: "faux", modelId: "small" };

class RestartableMemoryStorage extends MemoryStorage {
  override close(): Promise<void> {
    return Promise.resolve();
  }
}

async function openHarness(
  responses: FauxResponseStep[],
  {
    storage = new MemoryStorage(),
    extension = SessionTitle,
  }: { storage?: Storage; extension?: Extension } = {},
) {
  const faux = fauxProvider({ models: [{ id: "main" }, { id: "small" }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { retry: { enabled: false } } },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: mainModel },
  });
  return { faux, harness, root };
}

async function submit(root: Conversation, content: string) {
  const submission = await root.submit({ type: "input", content }, context);
  await submission.wait(context);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function waitForNoTasks(harness: Harness) {
  await expect
    .poll(async () => {
      const inspection = await harness.inspect(context);
      return inspection.tasks.length;
    })
    .toBe(0);
}

function titleCall(title: string, id = "title-call") {
  return fauxAssistantMessage(fauxToolCall("set_title", { title }, { id }), {
    stopReason: "toolUse",
  });
}

type Opened = Awaited<ReturnType<typeof openHarness>>;

async function titleState(opened: Opened) {
  return opened.harness.snapshot(SessionTitleDoc, opened.root.id, context);
}

async function expectTitle(
  opened: Opened,
  expected: SessionTitleState | undefined,
) {
  const state = await titleState(opened);
  expect(state).toEqual(expected);
}

async function expectTitleMatch(
  opened: Opened,
  expected: Partial<SessionTitleState>,
) {
  const state = await titleState(opened);
  expect(state).toMatchObject(expected);
}

async function waitForTitleStatus(
  opened: Opened,
  status: SessionTitleState["status"],
) {
  await expect
    .poll(async () => {
      const state = await titleState(opened);
      return state?.status;
    })
    .toBe(status);
}

async function waitForTitleValue(opened: Opened, title: string) {
  await expect
    .poll(async () => {
      const state = await titleState(opened);
      return state?.title;
    })
    .toBe(title);
}

describe("SessionTitle", () => {
  describe("generation", () => {
    it("generates one title through a dedicated tool-only conversation", async () => {
      const requests: TranscriptContext[] = [];
      const opened = await openHarness([
        (request) => {
          requests.push(request);
          return fauxAssistantMessage(
            "The timeout is caused by a stale connection.",
          );
        },
        (request) => {
          requests.push(request);
          return titleCall("  Fix login timeout  ");
        },
        fauxAssistantMessage("The connection is now refreshed."),
      ]);

      try {
        await submit(opened.root, "Why does login time out?");
        await waitForTitleStatus(opened, "ready");
        await expectTitle(opened, {
          status: "ready",
          title: "Fix login timeout",
          source: "generated",
          taskId: null,
          attempts: 1,
        });
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0]?.messages)).not.toContain(
          "set_title",
        );
        expect(JSON.stringify(requests[1]?.messages)).toContain("set_title");
        expect(JSON.stringify(requests[1]?.messages)).toContain(
          "Why does login time out?",
        );
        expect(JSON.stringify(requests[1]?.messages)).toContain(
          "stale connection",
        );
        const rootContext = await opened.root.context(context);
        expect(JSON.stringify(rootContext.messages)).not.toContain(
          "Fix login timeout",
        );

        await submit(opened.root, "Apply the fix.");
        await waitForNoTasks(opened.harness);
        expect(opened.faux.state.callCount).toBe(3);
        await expectTitleMatch(opened, {
          title: "Fix login timeout",
          attempts: 1,
        });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("does not duplicate a pending title task", async () => {
      const gate = deferred();
      const opened = await openHarness([
        fauxAssistantMessage("First answer"),
        async (_request, options) => {
          await Promise.race([gate.promise, aborted(options?.signal)]);
          return titleCall("Single title");
        },
        fauxAssistantMessage("Second answer"),
      ]);

      try {
        await submit(opened.root, "First question");
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        await submit(opened.root, "Second question");
        expect(opened.faux.state.callCount).toBe(3);
        gate.resolve();
        await waitForTitleStatus(opened, "ready");
        await waitForNoTasks(opened.harness);
        await expectTitleMatch(opened, {
          title: "Single title",
          attempts: 1,
        });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("waits for a successful main answer", async () => {
      const opened = await openHarness([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Main answer failed",
        }),
        fauxAssistantMessage("Successful answer"),
        titleCall("Successful session"),
      ]);

      try {
        await submit(opened.root, "First question");
        await waitForNoTasks(opened.harness);
        expect(opened.faux.state.callCount).toBe(1);
        await expectTitle(opened, undefined);

        await submit(opened.root, "Second question");
        await waitForTitleValue(opened, "Successful session");
        await expectTitleMatch(opened, { attempts: 1 });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("retries a failed title request on the next successful run", async () => {
      const opened = await openHarness([
        fauxAssistantMessage("First answer"),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Naming failed",
        }),
        fauxAssistantMessage("Second answer"),
        titleCall("Recovered session title"),
      ]);

      try {
        await submit(opened.root, "First question");
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        await waitForNoTasks(opened.harness);
        await expectTitle(opened, {
          status: "idle",
          title: null,
          source: null,
          taskId: null,
          attempts: 1,
        });

        await submit(opened.root, "Second question");
        await waitForTitleValue(opened, "Recovered session title");
        await expectTitleMatch(opened, { status: "ready", attempts: 2 });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("accepts only the first title write when the model calls twice", async () => {
      const opened = await openHarness([
        fauxAssistantMessage("Main answer"),
        fauxAssistantMessage(
          [
            fauxToolCall(
              "set_title",
              { title: "First title" },
              { id: "first" },
            ),
            fauxToolCall(
              "set_title",
              { title: "Second title" },
              { id: "second" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
      ]);

      try {
        await submit(opened.root, "Start work");
        await waitForTitleStatus(opened, "ready");
        await waitForNoTasks(opened.harness);
        await expectTitleMatch(opened, {
          title: "First title",
          attempts: 1,
        });
        expect(opened.faux.state.callCount).toBe(2);
      } finally {
        await opened.harness.close(context);
      }
    });

    it.each([
      ["plain text", fauxAssistantMessage("Plain text title")],
      ["invalid arguments", titleCall("   ")],
    ])("stores no title for %s", async (_case, response) => {
      const opened = await openHarness([
        fauxAssistantMessage("Main answer"),
        response,
      ]);

      try {
        await submit(opened.root, "Start work");
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        await waitForNoTasks(opened.harness);
        await expectTitle(opened, {
          status: "idle",
          title: null,
          source: null,
          taskId: null,
          attempts: 1,
        });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("recovers the naming conversation after a restart", async () => {
      const storage = new RestartableMemoryStorage();
      const gate = deferred();
      let opened = await openHarness(
        [
          fauxAssistantMessage("Main answer"),
          async (_request, options) => {
            await Promise.race([gate.promise, aborted(options?.signal)]);
            return titleCall("Interrupted title");
          },
        ],
        { storage },
      );

      try {
        await submit(opened.root, "Start durable work");
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        await opened.harness.close(context);

        opened = await openHarness([titleCall("Durable title")], { storage });
        opened.harness.resume();
        await waitForTitleValue(opened, "Durable title");
        await waitForNoTasks(opened.harness);
        expect(opened.faux.state.callCount).toBe(1);
        await opened.harness.close(context);

        opened = await openHarness([fauxAssistantMessage("Another answer")], {
          storage,
        });
        await submit(opened.root, "Continue work");
        await waitForNoTasks(opened.harness);
        expect(opened.faux.state.callCount).toBe(1);
        await expectTitleMatch(opened, {
          title: "Durable title",
          attempts: 1,
        });
      } finally {
        await opened.harness.close(context).catch(() => {});
      }
    });
  });

  describe("manual titles", () => {
    it("preserves a manual title set before the first run", async () => {
      const opened = await openHarness([fauxAssistantMessage("Main answer")]);

      try {
        await setSessionTitle(opened.root, "Manual title", context);
        await submit(opened.root, "Start work");
        await waitForNoTasks(opened.harness);
        expect(opened.faux.state.callCount).toBe(1);
        await expectTitle(opened, {
          status: "ready",
          title: "Manual title",
          source: "manual",
          taskId: null,
          attempts: 0,
        });
      } finally {
        await opened.harness.close(context);
      }
    });

    it("preserves a manual title set while generation is running", async () => {
      const gate = deferred();
      const opened = await openHarness([
        fauxAssistantMessage("Main answer"),
        async (_request, options) => {
          await Promise.race([gate.promise, aborted(options?.signal)]);
          return titleCall("Generated title");
        },
      ]);

      try {
        await submit(opened.root, "Start work");
        await expect.poll(() => opened.faux.state.callCount).toBe(2);
        await setSessionTitle(opened.root, "Manual title", context);
        gate.resolve();
        await waitForNoTasks(opened.harness);
        await expectTitleMatch(opened, {
          status: "ready",
          title: "Manual title",
          source: "manual",
          attempts: 1,
        });
      } finally {
        await opened.harness.close(context);
      }
    });
  });
});

describe("createSessionTitleExtension", () => {
  it("falls back to the conversation model", async () => {
    const models: string[] = [];
    const opened = await openHarness(
      [
        (_request, _options, _state, model) => {
          models.push(model.id);
          return fauxAssistantMessage("Main answer");
        },
        (_request, _options, _state, model) => {
          models.push(model.id);
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "Small model failed",
          });
        },
        (_request, _options, _state, model) => {
          models.push(model.id);
          return titleCall("Fallback title");
        },
      ],
      { extension: createSessionTitleExtension({ model: smallModel }) },
    );

    try {
      await submit(opened.root, "Name this session");
      await waitForTitleStatus(opened, "ready");
      expect(models).toEqual(["main", "small", "main"]);
    } finally {
      await opened.harness.close(context);
    }
  });

  describe("prompts", () => {
    const promptCases: {
      name: string;
      options: SessionTitleOptions;
      included: string[];
      excluded: string[];
    }[] = [
      {
        name: "replaces the naming system prompt",
        options: { systemPrompt: "You name support conversations." },
        included: ["You name support conversations."],
        excluded: ["You name conversations."],
      },
      {
        name: "appends to the naming system prompt",
        options: { appendSystemPrompt: "Use sentence case." },
        included: ["Call set_title exactly once", "Use sentence case."],
        excluded: [],
      },
    ];

    it.each(promptCases)("$name", async ({ options, included, excluded }) => {
      let namingRequest: TranscriptContext | undefined;
      const opened = await openHarness(
        [
          fauxAssistantMessage("Main answer"),
          (request) => {
            namingRequest = request;
            return titleCall("Custom title");
          },
        ],
        { extension: createSessionTitleExtension(options) },
      );

      try {
        await submit(opened.root, "Start work");
        await waitForTitleStatus(opened, "ready");
        expect(namingRequest).toBeDefined();
        const prompt = JSON.stringify(namingRequest?.messages);
        for (const text of included) expect(prompt).toContain(text);
        for (const text of excluded) expect(prompt).not.toContain(text);
      } finally {
        await opened.harness.close(context);
      }
    });
  });
});

describe("setSessionTitle", () => {
  it("rejects an invalid manual title", async () => {
    const opened = await openHarness([]);

    try {
      await expect(
        setSessionTitle(opened.root, " ".repeat(4), context),
      ).rejects.toThrow(TypeError);
      await expect(
        setSessionTitle(opened.root, "x".repeat(81), context),
      ).rejects.toThrow(TypeError);
    } finally {
      await opened.harness.close(context);
    }
  });
});
