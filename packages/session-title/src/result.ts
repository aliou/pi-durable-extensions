import { defineDoc } from "@earendil-works/pi-durable";

export const TitleResultDoc = defineDoc<{ stored: boolean }>({
  kind: "session-title.result",
  version: 1,
  scope: "task",
  initial: () => ({ stored: false }),
  checkpointWhen: () => false,
});
