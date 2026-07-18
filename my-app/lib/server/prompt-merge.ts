/**
 * Merge a style preset's guidance with the user's prompt without calling a
 * cloud relay. The prompt optimizer can still improve text through local/BYOK;
 * this helper must stay deterministic.
 */
export async function mergePresetPrompt(
  presetGuidance: string,
  userPrompt: string,
): Promise<string> {
  if (!presetGuidance.trim()) return userPrompt;
  if (!userPrompt.trim()) return presetGuidance;

  return `${presetGuidance}\n\n${userPrompt}`;
}
