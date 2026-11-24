import { rm } from "node:fs/promises";
import productJson from "../product.json" with { type: "json" };

const { appName: APP_NAME } = productJson;

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "electron/resources/speech-helper",
  `electron/resources/${APP_NAME} Speech.app`,
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
