export const RENDERER_ERROR_REPORT_LIMIT = 20;

export function createRendererErrorAdmission(limit = RENDERER_ERROR_REPORT_LIMIT) {
  const admitted = new Set<string>();
  return (signature: string): boolean => {
    if (admitted.size >= limit || admitted.has(signature)) return false;
    admitted.add(signature);
    return true;
  };
}
