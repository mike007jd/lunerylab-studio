"use client";

// Failing fixture: Replicate credentials must never enter a client bundle.
import Replicate from "replicate";

export function forbiddenReplicateHook() {
  return Replicate;
}
