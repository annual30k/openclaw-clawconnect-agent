import { buildWindowsCommandLine } from "./process-invocation.js";

/** 宿主 exe 的命令行开关：把"作为服务登录"权限授予指定账户（需要管理员）。 */
export const WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG = "--grant-logon-right";

export interface WindowsServiceHostConfig {
  executablePath: string;
  executableArgs: string[];
  workingDirectory: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

/**
 * 宿主配置是 UTF-8 的 `key=value` 逐行文件，由宿主每次（重新）启动 Agent 前重新读取。
 * 因此 `clawconnect install` 刷新 Node/CLI 路径后，不需要重建服务注册就能生效。
 * 值里不允许换行，否则一行会被拆成两个键。
 */
export function buildWindowsServiceHostConfig(config: WindowsServiceHostConfig): string {
  const entries: Array<[string, string]> = [
    ["exe", config.executablePath],
    ["args", buildWindowsCommandLine(config.executableArgs)],
    ["cwd", config.workingDirectory],
    ["out", config.stdoutLogPath],
    ["err", config.stderrLogPath],
  ];
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`Windows service host config value for "${key}" must not contain line breaks`);
    }
  }
  return `${entries.map(([key, value]) => `${key}=${value}`).join("\r\n")}\r\n`;
}

/**
 * Windows 服务宿主（C#）。Node 进程自己不能响应 SCM 的启动请求（会报 1053），
 * 所以需要一个极小的原生宿主：作为服务运行，监督 Agent 子进程，退出后自动重启。
 *
 * 只使用 .NET Framework 4 自带 csc.exe 支持的 C# 5 语法（不用字符串插值、`?.`、表达式体成员），
 * 这样任何 Windows 10 / Server 2016+ 机器无需安装 SDK 就能在安装时编译。
 */
export function buildWindowsServiceHostSource(): string {
  return `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace ClawConnect
{
    public sealed class AgentServiceHost : ServiceBase
    {
        // Agent 退出（崩溃、被杀）后的重启间隔。固定值：同样的故障永远得到同样的恢复节奏。
        private const int RestartDelayMs = 5000;
        private const int StopWaitMs = 15000;

        private readonly string configPath;
        private readonly ManualResetEvent stopSignal = new ManualResetEvent(false);
        private readonly object childLock = new object();
        private Thread supervisor;
        private Process child;

        public AgentServiceHost(string serviceName, string configPath)
        {
            this.ServiceName = serviceName;
            this.configPath = configPath;
            this.CanStop = true;
            this.AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            supervisor = new Thread(Supervise);
            supervisor.IsBackground = true;
            supervisor.Start();
        }

        protected override void OnStop()
        {
            stopSignal.Set();
            KillChild();
            if (supervisor != null)
            {
                supervisor.Join(StopWaitMs);
            }
        }

        private void Supervise()
        {
            while (!stopSignal.WaitOne(0))
            {
                HostConfig config = null;
                try
                {
                    config = HostConfig.Load(configPath);
                    RunChild(config);
                }
                catch (Exception error)
                {
                    WriteHostLog(config, "supervisor error: " + error.Message);
                }
                if (stopSignal.WaitOne(RestartDelayMs))
                {
                    break;
                }
            }
        }

        private void RunChild(HostConfig config)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo(config.Executable, config.Arguments);
            startInfo.WorkingDirectory = config.WorkingDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            using (FileStream stdoutLog = OpenAppend(config.StdoutLog))
            using (FileStream stderrLog = OpenAppend(config.StderrLog))
            {
                Process process = Process.Start(startInfo);
                lock (childLock)
                {
                    child = process;
                }
                WriteHostLog(config, "agent started, pid " + process.Id);
                // 直接搬运原始字节，不做编码转换，日志保持 Agent 输出的 UTF-8。
                Thread outPump = StartPump(process.StandardOutput.BaseStream, stdoutLog);
                Thread errPump = StartPump(process.StandardError.BaseStream, stderrLog);
                process.WaitForExit();
                outPump.Join(2000);
                errPump.Join(2000);
                WriteHostLog(config, "agent exited with code " + process.ExitCode);
                lock (childLock)
                {
                    child = null;
                }
            }
        }

        private static Thread StartPump(Stream source, Stream target)
        {
            Thread pump = new Thread(delegate ()
            {
                byte[] buffer = new byte[8192];
                int read;
                try
                {
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        target.Write(buffer, 0, read);
                        target.Flush();
                    }
                }
                catch (IOException)
                {
                }
                catch (ObjectDisposedException)
                {
                }
            });
            pump.IsBackground = true;
            pump.Start();
            return pump;
        }

        private static FileStream OpenAppend(string path)
        {
            return new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        }

        private void KillChild()
        {
            Process target;
            lock (childLock)
            {
                target = child;
            }
            if (target == null)
            {
                return;
            }
            try
            {
                // /T 连同 Agent 派生的子进程一起结束，避免遗留孤儿进程占用端口或文件。
                ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/T /F /PID " + target.Id);
                kill.UseShellExecute = false;
                kill.CreateNoWindow = true;
                using (Process killer = Process.Start(kill))
                {
                    killer.WaitForExit(10000);
                }
            }
            catch (Exception)
            {
            }
        }

        private static void WriteHostLog(HostConfig config, string message)
        {
            if (config == null)
            {
                return;
            }
            try
            {
                using (FileStream log = OpenAppend(config.StderrLog))
                {
                    byte[] line = new UTF8Encoding(false).GetBytes(
                        "[clawconnect-service-host] " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + "\\r\\n");
                    log.Write(line, 0, line.Length);
                }
            }
            catch (Exception)
            {
            }
        }

        public static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "${WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG}")
            {
                return LogonRight.Grant(args[1]);
            }
            if (args.Length != 2)
            {
                Console.Error.WriteLine("usage: <serviceName> <configPath> | ${WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG} <account>");
                return 64;
            }
            ServiceBase.Run(new AgentServiceHost(args[0], args[1]));
            return 0;
        }
    }

    internal sealed class HostConfig
    {
        public string Executable;
        public string Arguments;
        public string WorkingDirectory;
        public string StdoutLog;
        public string StderrLog;

        public static HostConfig Load(string path)
        {
            HostConfig config = new HostConfig();
            foreach (string line in File.ReadAllLines(path, new UTF8Encoding(false)))
            {
                int split = line.IndexOf('=');
                if (split <= 0)
                {
                    continue;
                }
                string key = line.Substring(0, split);
                string value = line.Substring(split + 1);
                if (key == "exe") config.Executable = value;
                else if (key == "args") config.Arguments = value;
                else if (key == "cwd") config.WorkingDirectory = value;
                else if (key == "out") config.StdoutLog = value;
                else if (key == "err") config.StderrLog = value;
            }
            if (string.IsNullOrEmpty(config.Executable) || string.IsNullOrEmpty(config.StdoutLog)
                || string.IsNullOrEmpty(config.StderrLog) || string.IsNullOrEmpty(config.WorkingDirectory))
            {
                throw new InvalidDataException("incomplete service host config: " + path);
            }
            if (config.Arguments == null)
            {
                config.Arguments = "";
            }
            return config;
        }
    }

    // 给账户授予 SeServiceLogonRight。用账户运行服务时必须具备该权限，否则服务会以 1069 启动失败。
    internal static class LogonRight
    {
        private const uint PolicyCreateAccount = 0x00000010;
        private const uint PolicyLookupNames = 0x00000800;

        [StructLayout(LayoutKind.Sequential)]
        private struct LsaObjectAttributes
        {
            public int Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public int Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LsaUnicodeString
        {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }

        [DllImport("advapi32.dll")]
        private static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaObjectAttributes attributes,
            uint desiredAccess, out IntPtr policyHandle);

        [DllImport("advapi32.dll")]
        private static extern uint LsaAddAccountRights(IntPtr policyHandle, IntPtr accountSid,
            LsaUnicodeString[] userRights, uint countOfRights);

        [DllImport("advapi32.dll")]
        private static extern uint LsaClose(IntPtr policyHandle);

        [DllImport("advapi32.dll")]
        private static extern int LsaNtStatusToWinError(uint status);

        public static int Grant(string account)
        {
            IntPtr policy = IntPtr.Zero;
            IntPtr sidBuffer = IntPtr.Zero;
            IntPtr rightBuffer = IntPtr.Zero;
            try
            {
                SecurityIdentifier sid = (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
                byte[] sidBytes = new byte[sid.BinaryLength];
                sid.GetBinaryForm(sidBytes, 0);
                sidBuffer = Marshal.AllocHGlobal(sidBytes.Length);
                Marshal.Copy(sidBytes, 0, sidBuffer, sidBytes.Length);

                LsaObjectAttributes attributes = new LsaObjectAttributes();
                attributes.Length = Marshal.SizeOf(typeof(LsaObjectAttributes));
                uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyCreateAccount | PolicyLookupNames, out policy);
                if (status != 0)
                {
                    Console.Error.WriteLine("LsaOpenPolicy failed: " + LsaNtStatusToWinError(status));
                    return 1;
                }

                string right = "SeServiceLogonRight";
                rightBuffer = Marshal.StringToHGlobalUni(right);
                LsaUnicodeString[] rights = new LsaUnicodeString[1];
                rights[0].Buffer = rightBuffer;
                rights[0].Length = (ushort)(right.Length * 2);
                rights[0].MaximumLength = (ushort)((right.Length + 1) * 2);
                status = LsaAddAccountRights(policy, sidBuffer, rights, 1);
                if (status != 0)
                {
                    Console.Error.WriteLine("LsaAddAccountRights failed: " + LsaNtStatusToWinError(status));
                    return 1;
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("grant logon right failed: " + error.Message);
                return 1;
            }
            finally
            {
                if (policy != IntPtr.Zero) LsaClose(policy);
                if (sidBuffer != IntPtr.Zero) Marshal.FreeHGlobal(sidBuffer);
                if (rightBuffer != IntPtr.Zero) Marshal.FreeHGlobal(rightBuffer);
            }
        }
    }
}
`;
}
