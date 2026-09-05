import type Anthropic from "@anthropic-ai/sdk";

export type ClientMessage = {
  type: "start";
  requestId: string;
  params: Anthropic.MessageCreateParamsStreaming;
};

export type ServerFrame =
  | { type: "event"; requestId: string; event: Anthropic.RawMessageStreamEvent }
  | { type: "done"; requestId: string }
  | { type: "error"; requestId: string; message: string };
