// Assemble the `openmausbot` npm package: the self-contained server bundle,
// the built UI, the bundled skills and the CLI, with a package.json of its
// own. `npx openmausbot serve` then needs Node 24+ and nothing else.
//
//   pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs
//   cd release/npm && npm pack        # or npm publish --access public
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release", "npm");
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const required of ["dist-server/index.js", "dist-server/openmausbot.js", "dist/index.html"]) {
  if (!existsSync(join(root, required))) {
    console.error(`missing ${required}: run \`pnpm build:server && pnpm exec vite build\` first`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "dist-server"), join(out, "dist-server"), { recursive: true });
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
if (existsSync(join(root, "skills"))) cpSync(join(root, "skills"), join(out, "skills"), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

// The bin lives next to the bundle so serverEntry() finds index.js by path.
writeFileSync(join(out, "cli.js"), `#!/usr/bin/env node\nimport "./dist-server/openmausbot.js";\n`);

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "openmausbot",
      version: app.version,
      description: "Run the OpenMausBot server anywhere and pair your devices to it",
      license: "Apache-2.0",
      type: "module",
      bin: { openmausbot: "cli.js" },
      files: ["cli.js", "dist-server", "dist", "skills", "LICENSE", "README.md"],
      engines: { node: ">=24" },
      repository: { type: "git", url: "https://github.com/milind-soni/OpenMausBot.git" },
      homepage: "https://github.com/milind-soni/OpenMausBot#readme",
      keywords: ["openmausbot", "agents", "self-hosted", "server"],
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(out, "README.md"),
  `# openmausbot

Run the OpenMausBot server on any machine with Node 24+, then pair your
devices to it.

\`\`\`sh
npx openmausbot serve                 # starts the server, prints a pairing link + QR
npx openmausbot serve --tailscale     # HTTPS over your tailnet, no domain needed
npx openmausbot pair --label "Phone"  # another device later
npx openmausbot sessions              # who is paired; "sessions revoke <id>" signs one out
\`\`\`

Engines (Claude Code, Codex, …) are separate CLIs signed in on the same
machine. Full guide: https://github.com/milind-soni/OpenMausBot/blob/main/docs/self-hosting.md
`,
);
console.log(`npm package assembled at ${out} (openmausbot@${app.version})`);
