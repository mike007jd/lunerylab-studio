"use client";

import { createContext, useContext } from "react";
import {
  type BootstrapSnapshot,
  useBootstrapSnapshot,
} from "@/lib/client/use-bootstrap-snapshot";

const BootstrapSnapshotContext = createContext<BootstrapSnapshot | null>(null);

interface BootstrapSnapshotProviderProps {
  children: React.ReactNode;
  intervalMs?: number;
  refreshKey?: string;
  initialData?: BootstrapSnapshot | null;
  disabled?: boolean;
}

export function BootstrapSnapshotProvider({
  children,
  intervalMs = 8_000,
  refreshKey,
  initialData,
  disabled,
}: BootstrapSnapshotProviderProps) {
  const snapshot = useBootstrapSnapshot({ intervalMs, refreshKey, initialData, disabled });

  return (
    <BootstrapSnapshotContext.Provider value={snapshot}>
      {children}
    </BootstrapSnapshotContext.Provider>
  );
}

export function useSharedBootstrapSnapshot() {
  return useContext(BootstrapSnapshotContext);
}
