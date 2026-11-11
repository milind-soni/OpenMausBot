import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { files: ["app/**", "components/**", "scripts/**"], rules: {
    "react-hooks/set-state-in-effect": "warn", "react-hooks/refs": "warn", "react-hooks/purity": "warn", "react-hooks/globals": "warn",
    "@next/next/no-html-link-for-pages": "warn", "react/no-unescaped-entities": "warn",
  } },
  { files: ["scripts/**"], rules: { "@typescript-eslint/no-explicit-any": "warn" } },
  // Never lint vendored or generated bundles.
  globalIgnores([".next/**", "convex/_generated/**", "public/**", "node_modules/**", "artifacts/**", "**/playwright-report/**", "**/test-results/**"]),
]);
