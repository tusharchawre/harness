// Which files count as private: the model may list their names, but reading one needs the user's
// yes (and makes later web requests in that reply ask too). Errs on the side of asking: a prompt
// costs a click, a leaked key costs much more.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { DATA_DIR } from "../config";

const H = homedir();

// Folders (under home) whose whole contents are private.
const HOME_DIRS = [
  // keys and cloud / dev CLIs
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".gem", ".cargo/credentials",
  ".config/gcloud", ".config/gh", ".config/hub", ".config/op", ".config/doctl", ".config/stripe", ".config/netlify",
  ".config/configstore", ".config/rclone", ".config/git/credentials", ".config/github-copilot", ".config/supabase",
  ".config/.wrangler", ".wrangler", ".netlify", ".fly", ".supabase", ".railway", ".expo", ".eas", ".vercel", ".cloudflared",
  ".terraform.d", ".pulumi", ".oci", ".ibmcloud", ".bluemix", ".chef", ".tsh", ".m2", ".gradle", ".ollama",
  ".local/share/keyrings", ".mozilla", ".thunderbird",
  // AI tools: configs with API keys, and transcripts that may hold pasted secrets
  ".claude", ".codex", ".cursor", ".gemini", ".copilot", ".continue", ".aider",
  // shell and REPL history (commands often carry tokens)
  ".zsh_sessions", ".local/share/fish",
  // macOS: Keychain, mail, messages, browsers, password managers, apps that store logins
  "Library/Keychains", "Library/Cookies", "Library/Safari", "Library/Mail", "Library/Messages", "Library/Accounts",
  "Library/Containers/com.apple.mail", "Library/Containers/com.apple.Safari", "Library/DBeaverData",
  ...[
    "Google/Chrome", "Firefox", "BraveSoftware", "Arc", "Microsoft Edge", "Vivaldi", "Opera", "Chromium", "com.operasoftware.Opera",
    "1Password", "Bitwarden", "Claude", "Slack", "discord", "Signal", "WhatsApp", "Telegram Desktop", "Postman", "Insomnia",
    "TablePlus", "com.raycast.macos", "com.apple.TCC", "Code/User/globalStorage", "Cursor/User/globalStorage", "Zed",
    "com.vercel.cli", "gh", "stripe",
  ].map((d) => `Library/Application Support/${d}`),
].map((d) => join(H, d));

const SYSTEM_DIRS = ["/Library/Keychains", "/private/var/db", "/private/var/root", "/private/etc/ssh", "/private/etc/sudoers.d", "/private/etc/master.passwd", "/private/etc/sudoers"];

// Any path segment that names a password manager or keychain.
const SEGMENT = /(1password|bitwarden|keepass|lastpass|dashlane|keychain)/i;

// Exact file names, anywhere.
const NAMES = new Set(
  [
    // shell startup files (often `export SOME_API_KEY=…`) and histories
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".kshrc", "config.fish",
    ".zsh_history", ".bash_history", ".sh_history", ".fish_history", "fish_history", ".python_history", ".node_repl_history",
    ".psql_history", ".mysql_history", ".sqlite_history", ".irb_history", ".rediscli_history", ".lesshst", ".viminfo",
    // credential files
    ".netrc", "_netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".git-credentials", ".pgpass", ".my.cnf", ".s3cfg",
    ".boto", ".vault-token", ".terraformrc", "terraform.rc", ".dockercfg", ".htpasswd", ".envrc", ".flaskenv", ".claude.json",
    "credentials", "credentials.json", "credentials.toml", "token.json", "auth.json", "mcp.json", ".mcp.json", "kubeconfig",
    "claude_desktop_config.json", "google-services.json", "googleservice-info.plist", "serviceaccountkey.json",
    "wp-config.php", "database.yml", "master.key", "keystore.properties", "gradle.properties", "local.settings.json",
    "appsettings.development.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
  ].map((n) => n.toLowerCase()),
);

// Name patterns, anywhere.
const PATTERNS = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /\.env$/i, // prod.env
  /\.(pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|kdb|keychain|keychain-db|opvault|agilekeychain|ovpn|gpg|pgp|age|tfstate|tfstate\.backup|tfvars)$/i,
  /^(client_secret|service[-_]?account|firebase-adminsdk|authkey_).*\.(json|p8)$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt|ini|conf)$/i,
  /_(rsa|dsa|ecdsa|ed25519)$/i, // custom-named SSH private keys
];

// Generic words in config-like files only, so auth.ts or tokenizer.json don't count.
const WORD = /(^|[._-])(secrets?|tokens?|passwords?|passwd|credentials?|api[-_]?keys?|keys?|auth|private)([._-]|$)/i;
const CONFIG_EXT = /(^[^.]*$|\.(json|txt|ya?ml|toml|ini|conf|cfg|properties|xml|plist|env)$)/i;

// Key material under an innocent name (e.g. ~/deploy-key): sniff the start of small files.
const KEY_HEADER = /-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----|^PuTTY-User-Key-File/;
function looksLikeKey(path: string) {
  try {
    const fd = openSync(path, "r");
    try {
      if (fstatSync(fd).size > 64_000 || !fstatSync(fd).isFile()) return false;
      const buf = Buffer.alloc(120);
      readSync(fd, buf, 0, 120, 0);
      return KEY_HEADER.test(buf.toString("latin1"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function isSecret(real: string): boolean {
  const name = basename(real);
  const lower = name.toLowerCase();
  const under = (d: string) => real === d || real.startsWith(d + sep);
  if ([...HOME_DIRS, ...SYSTEM_DIRS, DATA_DIR].some(under)) return true;
  if (real.split(sep).some((s) => SEGMENT.test(s))) return true;
  if (/\.(example|sample|template|dist|defaults?)$/i.test(name)) return false; // .env.example and friends are templates
  if (NAMES.has(lower) || PATTERNS.some((p) => p.test(name))) return true;
  if (WORD.test(name.replace(/^\./, "")) && CONFIG_EXT.test(name.replace(/^\./, ""))) return true;
  return looksLikeKey(real);
}
