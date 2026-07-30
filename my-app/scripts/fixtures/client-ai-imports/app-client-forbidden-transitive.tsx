"use client";

// Failing fixture: local indirection must not hide a server SDK import.
import { forbiddenServerHelper } from "./transitive-server-helper";

export function ForbiddenTransitiveClient() {
  return forbiddenServerHelper;
}
