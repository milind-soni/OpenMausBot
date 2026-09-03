import { win32 as windowsPath } from "node:path";

const ALLOWED_PACKAGE_HOSTS = new Set(["github.com", "www.github.com", "raw.githubusercontent.com"]);
const BOT_SHARE_HOST = "accounts.openmausbot.com";
const BOT_SHARE_PACKAGE_PATH = /^\/v1\/bot-shares\/[A-Za-z0-9_-]{21}\/package$/;
const GROK_BOT_DEEP_LINK = /^grokbot:\/\/app\/v1\/bot-template\?id=[A-Za-z0-9_-]{21}$/;
const GROK_BOT_PROTOCOL = "grokbot";

export function packageUrlFromDeepLink(rawValue) {
  const raw = String(rawValue);
  if (GROK_BOT_DEEP_LINK.test(raw)) return raw;

  let link;
  try {
    link = new URL(raw);
  } catch {
    return null;
  }
  if (
    link.protocol !== "openmausbot:" ||
    link.hostname !== "install" ||
    link.pathname ||
    link.username ||
    link.password ||
    link.port ||
    link.hash ||
    raw.includes("#") ||
    [...link.searchParams.keys()].length !== 1 ||
    [...link.searchParams.keys()][0] !== "url"
  ) return null;
  const rawPackage = link.searchParams.get("url");
  if (!rawPackage) return null;
  let packageUrl;
  try {
    packageUrl = new URL(rawPackage);
  } catch {
    return null;
  }
  const githubPackage =
    ALLOWED_PACKAGE_HOSTS.has(packageUrl.hostname) &&
    /\.(?:md|json)$/.test(packageUrl.pathname) &&
    !packageUrl.search &&
    !packageUrl.hash;
  const openMausShare =
    packageUrl.hostname === BOT_SHARE_HOST &&
    BOT_SHARE_PACKAGE_PATH.test(packageUrl.pathname) &&
    !packageUrl.search &&
    !packageUrl.hash;
  if (
    packageUrl.protocol !== "https:" ||
    packageUrl.username ||
    packageUrl.password ||
    packageUrl.port ||
    (!githubPackage && !openMausShare)
  ) return null;
  return packageUrl.toString();
}

export function packageUrlFromCommandLine(argv) {
  for (const value of argv) {
    const parsed = packageUrlFromDeepLink(value);
    if (parsed) return parsed;
  }
  return null;
}

export function grokBotProtocolClientContract({ platform, packaged, executablePath }) {
  if (
    platform !== "win32" ||
    packaged !== true ||
    typeof executablePath !== "string" ||
    !windowsPath.isAbsolute(executablePath) ||
    windowsPath.extname(executablePath).toLowerCase() !== ".exe"
  ) return null;
  return {
    protocol: GROK_BOT_PROTOCOL,
    executablePath,
    arguments: [],
  };
}

export function grokBotLinkHandlerStatus({
  platform,
  packaged,
  executablePath,
  isDefaultProtocolClient,
}) {
  const contract = grokBotProtocolClientContract({ platform, packaged, executablePath });
  const supported = contract !== null;
  let isDefault = false;
  if (contract) {
    try {
      isDefault = isDefaultProtocolClient(
        contract.protocol,
        contract.executablePath,
        contract.arguments,
      ) === true;
    } catch {
      isDefault = false;
    }
  }
  return { supported, isDefault };
}

export function enableGrokBotLinkHandler({
  platform,
  packaged,
  executablePath,
  isDefaultProtocolClient,
  setAsDefaultProtocolClient,
}) {
  const input = { platform, packaged, executablePath, isDefaultProtocolClient };
  const before = grokBotLinkHandlerStatus(input);
  if (!before.supported) return { ...before, registrationSucceeded: false };
  const contract = grokBotProtocolClientContract(input);
  let registrationSucceeded = false;
  try {
    registrationSucceeded = setAsDefaultProtocolClient(
      contract.protocol,
      contract.executablePath,
      contract.arguments,
    ) === true;
  } catch {
    registrationSucceeded = false;
  }
  const after = grokBotLinkHandlerStatus(input);
  return { ...after, registrationSucceeded };
}
