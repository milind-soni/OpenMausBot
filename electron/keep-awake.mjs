/** Keep this computer awake applies while something can reach it: the phone link is running without an error, or the
 * person's other computers may open it over Tailscale. */
export function reachableForKeepAwake(state, share) {
  return (state?.enabled === true && !state.error) || share?.on === true;
}
