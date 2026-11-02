// API keys in the macOS login Keychain (generic passwords, service "Harness"), via the `security` CLI.
// Writes go through `security -i` on stdin so the key never shows up in `ps` output.

const SERVICE = "Harness";
const cache = new Map<string, string | null>();

export function getKey(account: string): string | null {
  if (cache.has(account)) return cache.get(account)!;
  const r = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  const key = r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  cache.set(account, key);
  return key;
}

// Empty value = remove the key.
export function setKey(account: string, value: string) {
  const key = value.trim();
  cache.delete(account);
  if (!key) {
    Bun.spawnSync(["security", "delete-generic-password", "-s", SERVICE, "-a", account]);
    return;
  }
  // API keys are letters, digits, - and _; anything else would need quoting in `security -i`.
  if (!/^[\w-]{8,200}$/.test(key)) throw new Error("That doesn't look like an API key");
  const r = Bun.spawnSync(["security", "-i"], {
    stdin: new TextEncoder().encode(`add-generic-password -U -s ${SERVICE} -a ${account} -w ${key}\n`),
  });
  if (r.exitCode !== 0 || getKey(account) !== key) throw new Error(`Couldn't save to Keychain: ${r.stderr.toString().trim()}`);
}
