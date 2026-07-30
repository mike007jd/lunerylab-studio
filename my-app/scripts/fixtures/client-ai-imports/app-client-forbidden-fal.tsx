"use client";

// Failing fixture: credential-bearing provider SDKs are server-only.
import { fal } from "@fal-ai/client";

export function ForbiddenFalClient() {
  return fal;
}
