// End the process with a code once stdout and stderr have flushed. On Linux a
// pipe (CI's `| grep`, a journal) takes writes asynchronously, so
// `process.exit` right after `console.error` can drop the very line that
// says what went wrong. A write callback fires only once its data is out.
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((done) => stream.write("", () => done()));
  void Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => process.exit(code));
}
