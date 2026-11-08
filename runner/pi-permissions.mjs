// Explicitly loaded only for Origin's supervised Pi runs; personal extensions are untouched.
export default function originPermissions(pi) {
  pi.on('tool_call', async event => {
    try {
      const response = await fetch(process.env.ORIGIN_PERMISSION_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ORIGIN_PERMISSION_TOKEN}` },
        body: JSON.stringify({ toolName: event.toolName, input: event.input }),
      });
      if (response.ok && (await response.json()).allow === true) return;
    } catch {}
    return { block: true, reason: 'Origin permission was denied or the worker lost its lease' };
  });
}
