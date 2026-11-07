import { defineDoc, type TaskId } from "@earendil-works/pi-durable";
import { compile, nullable, str } from "@earendil-works/pi-schema";

export type SessionTitleState = {
  title: string | null;
  activeTaskId: TaskId | null;
};

const isStoredTitle = compile(nullable(str())).check;

export const SessionTitleDoc = defineDoc<SessionTitleState>({
  kind: "session-title.state",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ title: null, activeTaskId: null }),
  migrate: (value) => {
    if (!isStoredTitle(value.title)) throw new Error("Invalid stored title");
    return { title: value.title, activeTaskId: null };
  },
  checkpointWhen: () => false,
});
