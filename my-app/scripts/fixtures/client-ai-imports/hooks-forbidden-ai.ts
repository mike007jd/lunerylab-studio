"use client";

// Failing fixture: root hooks must not import server AI packages.
import { generateText } from "ai";

export function forbiddenHookFixture() {
  return generateText;
}
