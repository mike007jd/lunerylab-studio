"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAVIGATION_FEEDBACK_TIMEOUT_MS = 8_000;

function shouldShowNavigationFeedback(event: MouseEvent, anchor: HTMLAnchorElement) {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== "_self") return false;

  const rawHref = anchor.getAttribute("href");
  if (!rawHref || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) return false;

  const destination = new URL(rawHref, window.location.href);
  if (destination.origin !== window.location.origin) return false;

  const current = new URL(window.location.href);
  const sameDocument =
    destination.pathname === current.pathname &&
    destination.search === current.search &&
    destination.hash !== current.hash;

  if (sameDocument) return false;

  return destination.href !== current.href;
}

export function NavigationFeedback() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const clearPending = () => {
      setPending(false);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (pendingAnchorRef.current) {
        pendingAnchorRef.current.removeAttribute("aria-busy");
        delete pendingAnchorRef.current.dataset.navigationPending;
        pendingAnchorRef.current = null;
      }
    };

    clearPending();
    return clearPending;
  }, [pathname]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || !shouldShowNavigationFeedback(event, anchor)) return;

      pendingAnchorRef.current?.removeAttribute("aria-busy");
      if (pendingAnchorRef.current) {
        delete pendingAnchorRef.current.dataset.navigationPending;
      }

      pendingAnchorRef.current = anchor;
      anchor.setAttribute("aria-busy", "true");
      anchor.dataset.navigationPending = "true";
      setPending(true);

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        setPending(false);
        anchor.removeAttribute("aria-busy");
        delete anchor.dataset.navigationPending;
        if (pendingAnchorRef.current === anchor) {
          pendingAnchorRef.current = null;
        }
        timeoutRef.current = null;
      }, NAVIGATION_FEEDBACK_TIMEOUT_MS);
    };

    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  if (!pending) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed left-0 right-0 top-0 z-(--z-toast) h-0.5 overflow-hidden bg-(--accent-glow-soft)"
    >
      <div className="h-full w-1/3 animate-[navigation-feedback_1s_ease-in-out_infinite] bg-(--accent-glow)" />
    </div>
  );
}
