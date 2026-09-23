// Electron's default relaunch reuses native launch arguments, not the JS argv
// from which main consumed the fixed, one-shot organisation action. Keep the
// updater's adapter explicit too; its Deb/Rpm/Pacman paths share this method.
export function patchOrganizationUpdater(source) {
  const before = "      relaunch() {\n        this.app.relaunch();\n      }";
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one updater relaunch adapter to patch, found ${count}`);
  return source.replace(before, '      relaunch() {\n        this.app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== "openmausbot://organization") });\n      }');
}
