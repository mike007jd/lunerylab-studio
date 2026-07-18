export function hasFalImageEditBackend(models: Array<{ id: string }>): boolean {
  return models.some((model) => model.id.startsWith("byok:fal:"));
}
