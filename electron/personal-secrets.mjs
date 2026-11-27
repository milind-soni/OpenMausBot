// Security: the places in a person's home folder that no lent folder ever reaches, even for a read
// (shared-computer-access.mjs). The move step reads it too, to say which skills can't read their files on My Cloud.
/** Keys that open a shell or an account, and places that run code by themselves: no folder grant reaches these. Relative to home. */
export const PERSONAL_SECRETS = Object.freeze([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".gitconfig", ".npmrc", ".pypirc",
  // Shell start-up files run in every new terminal and often export API keys.
  ".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
  ".claude", ".claude.json", ".codex", ".mozilla", ".local/share/keyrings", ".local/bin",
  ".config/gh", ".config/gcloud", ".config/op", ".config/git", ".config/fish", ".config/autostart", ".config/systemd",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  "Library/Keychains", "Library/Cookies", "Library/LaunchAgents", "Library/Safari",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox", "Library/Application Support/Arc",
  ".cua",
  // Windows: the browsers' saved passwords and cookies, the credential vault and its keys, and what runs at sign-in.
  "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data", "AppData/Local/BraveSoftware/Brave-Browser/User Data",
  "AppData/Roaming/Mozilla", "AppData/Local/Mozilla",
  "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/Microsoft/Vault", "AppData/Local/Microsoft/Vault",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  "Documents/PowerShell", "Documents/WindowsPowerShell",
]);
