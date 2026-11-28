export const GLM_ENDPOINTS = {
  international: { name: "GLM (Z.ai)", url: "https://api.z.ai/api/paas/v4" },
  china: { name: "GLM (Zhipu BigModel)", url: "https://open.bigmodel.cn/api/paas/v4" },
} as const;

export function isGlmOrigin(url: string): boolean {
  try {
    const origin = new URL(url).origin;
    return origin === "https://api.z.ai" || origin === "https://open.bigmodel.cn";
  } catch {
    return false;
  }
}
