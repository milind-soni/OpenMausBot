export type PrivateScreenFrame = { png: string; mime: string };

/** Checked again after capture: a user can take over mid-request, and the frame may already show what they typed. */
export async function captureOutsideHumanControl(
  control: () => { held: boolean; revision: number },
  capture: () => Promise<{ png: string; format: string }>,
): Promise<PrivateScreenFrame | null> {
  const before = control();
  if (before.held) return null;
  const { png, format } = await capture();
  const after = control();
  if (after.held || after.revision !== before.revision) return null;
  return { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
}
