/**
 * 把测试进程的用户主目录指向临时目录。
 *
 * Node 的 os.homedir() 在 POSIX 上读 HOME，在 Windows 上读 USERPROFILE；只改 HOME 时，
 * Windows 上的测试会把假配置写进真实的 %USERPROFILE%\.clawconnect，覆盖用户的配对。
 * 因此两个变量必须同时隔离，并在测试结束后原样恢复。
 */
const HOME_ENV_KEYS = ["HOME", "USERPROFILE"] as const;

export function isolateHomeDirectory(tempHome: string): () => void {
  const originals = HOME_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of HOME_ENV_KEYS) {
    process.env[key] = tempHome;
  }
  return () => {
    for (const [key, value] of originals) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
