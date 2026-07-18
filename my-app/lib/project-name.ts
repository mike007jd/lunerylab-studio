import type { TFunction } from "@/lib/i18n/provider";

export const PROJECT_NAME_MAX_LENGTH = 80;

export function normalizeProjectName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length > 0 && normalized.length <= PROJECT_NAME_MAX_LENGTH
    ? normalized
    : null;
}

export function buildDefaultProjectName(t: TFunction, now = new Date()): string {
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return t("studio.buildProjectName", { stamp });
}

export function resolveTemplateProjectName(
  template: { name: string; templateKey: string | null },
  t: TFunction,
): string {
  return template.templateKey
    ? t(`samples.${template.templateKey}.projectName`)
    : template.name;
}

export function resolveTemplateSessionTitle(
  templateKey: string | null,
  fallback: string,
  t: TFunction,
): string {
  return templateKey ? t(`samples.${templateKey}.sessionTitle`) : fallback;
}
