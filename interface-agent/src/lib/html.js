export function stripHtmlFences(value) {
  const trimmed = String(value || '').trim();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const embeddedFenceMatch = trimmed.match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
  if (embeddedFenceMatch) {
    return embeddedFenceMatch[1].trim();
  }
  return trimmed;
}
