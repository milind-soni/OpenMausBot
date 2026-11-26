/** Polls `check` every 25 ms until it gives a truthy value, or throws after `ms`. */
export const waitFor = async <T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 5_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
