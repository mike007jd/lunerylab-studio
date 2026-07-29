/** Browser / metadata title for a project detail route. */
export function buildProjectDocumentTitle(projectName: string): string {
  const name = projectName.trim();
  return name ? `${name} — Lunery Lab Studio` : "Lunery Lab Studio";
}
