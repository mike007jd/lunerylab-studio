"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "lunery:activeProjectId";

interface ActiveProjectContextValue {
  /** The project Studio generation lands in; null = no project chosen yet. */
  activeProjectId: string | null;
  setActiveProject: (id: string | null) => void;
}

const ActiveProjectContext = createContext<ActiveProjectContextValue | null>(null);

/** Holds the single "active project" shared across Studio, the sidebar, and the
 * project workspace, persisted to localStorage so it survives navigation and
 * reloads. Opening a project (or picking one in Studio) sets it; Studio defaults
 * new generations to it. No server state — purely a client preference. */
export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  // Hydrate after mount (client-only) so server and first client render match.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      // SSR-safe hydration: server and first client render both start null (no
      // mismatch), then we adopt the stored value post-mount. A lazy initializer
      // would instead read localStorage during render and cause a hydration
      // mismatch — so this is the one legitimate setState-in-effect here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setActiveProjectId(stored);
    } catch {
      // localStorage blocked (private mode / sandbox) — stay in-memory only.
    }
  }, []);

  const setActiveProject = useCallback((id: string | null) => {
    setActiveProjectId(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore persistence failures; the in-memory value still works this session.
    }
  }, []);

  const value = useMemo(
    () => ({ activeProjectId, setActiveProject }),
    [activeProjectId, setActiveProject],
  );

  return <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>;
}

export function useActiveProject(): ActiveProjectContextValue {
  const context = useContext(ActiveProjectContext);
  if (!context) {
    throw new Error("useActiveProject must be used within ActiveProjectProvider");
  }
  return context;
}
