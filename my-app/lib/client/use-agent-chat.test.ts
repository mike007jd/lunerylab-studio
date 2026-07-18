import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "@/components/studio/agent-chat/agent-chat-types";
import { mergeAgentThreadHistory } from "@/components/studio/agent-chat/use-agent-chat";

function message(id: string, text: string): AgentChatMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("mergeAgentThreadHistory", () => {
  it("hydrates persisted turns before live turns without duplicating ids", () => {
    const persisted = [message("persisted-1", "saved"), message("live-1", "same id")];
    const live = [message("live-1", "live")];

    const merged = mergeAgentThreadHistory(persisted, live);

    expect(merged.map((item) => item.id)).toEqual(["persisted-1", "live-1"]);
    expect(merged[1]).toBe(live[0]);
  });

  it("preserves the current array when history adds nothing", () => {
    const live = [message("live-1", "live")];
    expect(mergeAgentThreadHistory([message("live-1", "saved")], live)).toBe(live);
  });
});
