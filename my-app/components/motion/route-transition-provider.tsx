"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";

const MAX_NAVIGATION_WAIT_MS = 10_000;

interface RouteTransitionContextValue {
  activePathname: string;
  markPending: (href: string) => void;
  navigate: (href: string) => void;
  isTransitioning: boolean;
}

const RouteTransitionContext = createContext<RouteTransitionContextValue | null>(null);

interface PendingRoute {
  href: string;
  fromPathname: string;
}

interface RouteTransitionProviderProps {
  children: ReactNode;
}

export function shouldHandleTransitionClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  currentPathname: string,
): boolean {
  const isModifiedClick = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  const hasNonSelfTarget = Boolean(event.currentTarget.target && event.currentTarget.target !== "_self");
  const isExternalLink = /^https?:\/\//.test(href);

  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    isModifiedClick ||
    hasNonSelfTarget ||
    href === currentPathname ||
    isExternalLink
  );
}

function resolvePathnameFromHref(href: string): string {
  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    return new URL(href, base).pathname;
  } catch {
    return href.split(/[?#]/, 1)[0] || "/";
  }
}

export function RouteTransitionProvider({ children }: RouteTransitionProviderProps) {
  const pathname = usePathname();
  const router = useRouter();

  const [pendingRoute, setPendingRoute] = useState<PendingRoute | null>(null);
  const pendingHref = pendingRoute?.href ?? null;
  const pendingPathname = pendingHref ? resolvePathnameFromHref(pendingHref) : null;

  useEffect(() => {
    if (!pendingHref) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setPendingRoute(null);
    }, MAX_NAVIGATION_WAIT_MS);

    return () => window.clearTimeout(timeout);
  }, [pendingHref]);

  const navigate = useCallback(
    (href: string) => {
      if (resolvePathnameFromHref(href) === pathname) {
        return;
      }

      setPendingRoute({ href, fromPathname: pathname });
      startTransition(() => {
        router.push(href);
      });
    },
    [pathname, router],
  );

  const markPending = useCallback(
    (href: string) => {
      if (resolvePathnameFromHref(href) === pathname) {
        return;
      }

      setPendingRoute({ href, fromPathname: pathname });
    },
    [pathname],
  );

  useEffect(() => {
    if (!pendingRoute || !pendingPathname) {
      return;
    }

    if (pathname !== pendingPathname && pathname === pendingRoute.fromPathname) {
      return;
    }

    const clearTimeoutId = window.setTimeout(() => {
      setPendingRoute(null);
    }, 0);

    return () => window.clearTimeout(clearTimeoutId);
  }, [pathname, pendingPathname, pendingRoute]);

  const activePathname = pendingPathname ?? pathname;
  const isTransitioning = pendingPathname !== null && pendingPathname !== pathname;

  const contextValue = useMemo<RouteTransitionContextValue>(
    () => ({
      activePathname,
      markPending,
      navigate,
      isTransitioning,
    }),
    [activePathname, markPending, navigate, isTransitioning],
  );

  return (
    <RouteTransitionContext.Provider value={contextValue}>{children}</RouteTransitionContext.Provider>
  );
}

export function useRouteTransition() {
  const context = useContext(RouteTransitionContext);

  if (!context) {
    throw new Error("useRouteTransition must be used within RouteTransitionProvider");
  }

  return context;
}

export function useOptionalRouteTransition() {
  return useContext(RouteTransitionContext);
}
