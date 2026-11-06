import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  ConversationRecord,
  TaskId,
  TaskRecord,
  Tx,
} from "@earendil-works/pi-durable";
import { createMock } from "@golevelup/ts-vitest";
import { describe, expect, it } from "vitest";
import { GENERATE_TITLE_TASK_NAME } from "./names";
import type { SessionTitleState } from "./state";
import { SetTitleTool } from "./tool";

const conversationId = createMock<ConversationId>();
const namingConversationId = createMock<ConversationId>();
const taskId = createMock<TaskId>();
const otherTaskId = createMock<TaskId>();

type SetTitleApi = Parameters<typeof SetTitleTool.execute>[1];
type StoredTask = TaskRecord<null, { phase: "run" }, null>;

function pendingState(
  overrides: Partial<SessionTitleState> = {},
): SessionTitleState {
  return {
    status: "pending",
    title: null,
    source: null,
    taskId,
    attempts: 1,
    ...overrides,
  };
}

function createApi(
  state: SessionTitleState,
  {
    ownerTaskId = taskId,
    ownerKind = GENERATE_TITLE_TASK_NAME,
  }: { ownerTaskId?: TaskId | null; ownerKind?: string } = {},
): SetTitleApi {
  const tx = createMock<Tx>(
    {
      conversation: async () =>
        createMock<ConversationRecord>({
          id: namingConversationId,
          owner:
            ownerTaskId === null
              ? undefined
              : { conversationId, taskId: ownerTaskId },
        }),
      task: async () =>
        createMock<StoredTask>({
          id: taskId,
          kind: ownerKind,
          conversationId,
        }),
      doc: async () => state,
    },
    { strict: true },
  );
  return createMock<SetTitleApi>(
    {
      conversationId: namingConversationId,
      commit: async <T>(change: (tx: Tx) => T | Promise<T>) => change(tx),
    },
    { strict: true },
  );
}

describe("SetTitleTool", () => {
  it("stores a trimmed title for the owning pending task", async () => {
    const state = pendingState();

    const result = await SetTitleTool.execute(
      { title: "  Readable title  " },
      createApi(state),
      context,
    );

    expect(state).toEqual({
      status: "ready",
      title: "Readable title",
      source: "generated",
      taskId: null,
      attempts: 1,
    });
    expect(result).toMatchObject({
      output: [{ type: "text", text: "Session title: Readable title" }],
      details: { title: "Readable title", stored: true },
      control: { terminate: true },
    });
  });

  it.each([
    [
      "the title is already ready",
      pendingState({
        status: "ready",
        title: "Manual title",
        source: "manual",
        taskId: null,
      }),
    ],
    [
      "another task owns the pending state",
      pendingState({ taskId: otherTaskId }),
    ],
  ])("ignores a write when %s", async (_case, state) => {
    const before = { ...state };

    const result = await SetTitleTool.execute(
      { title: "Generated title" },
      createApi(state),
      context,
    );

    expect(state).toEqual(before);
    expect(result).toMatchObject({
      output: [{ type: "text", text: "Session title unchanged" }],
      details: { title: "Generated title", stored: false },
      control: { terminate: true },
    });
  });

  it("rejects a conversation without an owning task", async () => {
    await expect(
      SetTitleTool.execute(
        { title: "Generated title" },
        createApi(pendingState(), { ownerTaskId: null }),
        context,
      ),
    ).rejects.toThrow("The naming conversation has no owning task");
  });

  it("rejects a conversation owned by another task kind", async () => {
    await expect(
      SetTitleTool.execute(
        { title: "Generated title" },
        createApi(pendingState(), { ownerKind: "other.task" }),
        context,
      ),
    ).rejects.toThrow("The naming conversation has no title task");
  });
});
