// Offline standalone-app double: without CLI mode it exits 0 with GUI text,
// just like the reported macOS install when launched from a desktop sidecar.
const mode = process.env.FAKE_TAILSCALE_OUTPUT;
if (mode === "gui" || process.env.TAILSCALE_BE_CLI !== "1") {
  console.log("The Tailscale GUI failed to start: private diagnostic omitted");
} else if (mode === "invalid") {
  console.log("invalid JSON with private diagnostic omitted");
} else if (process.argv[2] === "status") {
  if (process.argv[3] !== "--json") process.exit(2);
  console.log(JSON.stringify({
    BackendState: "Running",
    Self: {
      DNSName: mode === "no-dns" ? "" : "fixture.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.7"],
    },
  }));
} else if (process.argv[2] === "serve") {
  console.log("Serve configuration updated");
} else {
  process.exit(2);
}
