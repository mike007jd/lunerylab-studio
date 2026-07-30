"use client";

// Failing fixture: app client modules must not import @ai-sdk/openai.
import { createOpenAI } from "@ai-sdk/openai";

export function ForbiddenAppClient() {
  return createOpenAI;
}
