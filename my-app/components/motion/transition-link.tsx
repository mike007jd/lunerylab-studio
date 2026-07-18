"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ComponentProps, type MouseEvent } from "react";
import {
  shouldHandleTransitionClick,
  useOptionalRouteTransition,
} from "@/components/motion/route-transition-provider";

interface TransitionLinkProps extends Omit<ComponentProps<typeof Link>, "onClick"> {
  disableTransition?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function TransitionLink({
  href,
  disableTransition = false,
  onClick,
  ...rest
}: TransitionLinkProps) {
  const pathname = usePathname();
  const routeTransition = useOptionalRouteTransition();

  const hrefString = typeof href === "string" ? href : href.pathname ?? "";

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);

    if (event.defaultPrevented || disableTransition || !routeTransition) {
      return;
    }

    if (!shouldHandleTransitionClick(event, hrefString, pathname)) {
      return;
    }

    routeTransition.markPending(hrefString);
  };

  return (
    <Link href={href} onClick={handleClick} {...rest} />
  );
}
