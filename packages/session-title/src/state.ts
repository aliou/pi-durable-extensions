import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  defineDoc,
  type TaskId,
} from "@earendil-works/pi-durable";
import { parseTitle } from "./title";

export type SessionTitleState = {
  status: "idle" | "pending" | "ready";
  title: string | null;
  source: "generated" | "manual" | null;
  taskId: TaskId | null;
  attempts: number;
};

export const SessionTitleDoc = defineDoc<SessionTitleState>({
  kind: "session-title.state",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    status: "idle",
    title: null,
    source: null,
    taskId: null,
    attempts: 0,
  }),
  checkpointWhen: () => false,
});

export async function setSessionTitle(
  conversation: Conversation,
  title: string,
  context: Context,
): Promise<void> {
  const parsed = parseTitle(title);
  await conversation.commit(async (tx) => {
    const state = await tx.doc(SessionTitleDoc, conversation.id);
    state.status = "ready";
    state.title = parsed;
    state.source = "manual";
    state.taskId = null;
  }, context);
}
