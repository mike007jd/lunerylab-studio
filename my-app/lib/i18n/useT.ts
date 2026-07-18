import { useI18n } from "@/lib/i18n/provider";

export function useT() {
  const { t } = useI18n();
  return t;
}
