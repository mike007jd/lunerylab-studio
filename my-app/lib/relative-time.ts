// Locale-aware relative time, shared by asset cards and the project workspace.
// Formatters are comparatively heavy to construct, so cache them per locale at
// module scope (a 200-card grid would otherwise build 200 formatters per render).
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getRelativeFormat(locale: string): Intl.RelativeTimeFormat {
  let f = rtfCache.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    rtfCache.set(locale, f);
  }
  return f;
}

function getDateFormat(locale: string): Intl.DateTimeFormat {
  let f = dtfCache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
    dtfCache.set(locale, f);
  }
  return f;
}

/**
 * Formats a timestamp as locale-aware relative time ("5 minutes ago" / "5 分鐘前").
 * `justNow` is the caller's localized "just now" copy (sub-minute case). Falls
 * back to a short month/day date past ~30 days. Traditional Chinese works
 * natively via the BCP-47 locale (zh-TW), no Simplified fallthrough.
 */
export function formatRelativeTime(dateStr: string, locale: string, justNow: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return justNow;
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const rtf = getRelativeFormat(locale);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  if (diffHr < 24) return rtf.format(-diffHr, "hour");
  if (diffDay < 30) return rtf.format(-diffDay, "day");
  return getDateFormat(locale).format(new Date(dateStr));
}
