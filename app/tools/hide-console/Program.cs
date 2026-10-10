using System;
using System.Runtime.InteropServices;

namespace QQBotB.ConsoleHider
{
    /// <summary>
    /// 隐藏指定进程的控制台窗口。
    /// 用途：NapCat 启动 QQ 时会自建控制台（黑窗口），宿主侧无法用启动参数阻止，
    /// 只能在窗口出现后隐藏它。日志另经文件输出，界面照常可见。
    /// </summary>
    internal static class Program
    {
        /// <summary>隐藏窗口的 ShowWindow 命令码。</summary>
        private const int SwHide = 0;

        /// <summary>附加到目标进程的控制台。</summary>
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(uint processId);

        /// <summary>释放当前进程的控制台。</summary>
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        /// <summary>取当前进程所附加控制台的窗口句柄。</summary>
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        /// <summary>设置窗口显示状态。</summary>
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        /// <summary>
        /// 程序入口：逐个进程隐藏其控制台窗口。
        /// </summary>
        /// <param name="args">进程号列表</param>
        /// <returns>0 表示至少隐藏了一个窗口；2 表示一个也没隐藏；1 表示参数缺失</returns>
        private static int Main(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                Console.Error.WriteLine("用法：hide-console <pid> [pid ...]");
                return 1;
            }

            int hidden = 0;
            for (int index = 0; index < args.Length; index = index + 1)
            {
                uint processId = 0;
                bool parsed = uint.TryParse(args[index], out processId);
                if (!parsed)
                {
                    continue;
                }

                bool ok = HideConsoleOf(processId);
                if (ok)
                {
                    hidden = hidden + 1;
                }
            }

            if (hidden > 0)
            {
                return 0;
            }

            return 2;
        }

        /// <summary>
        /// 隐藏单个进程的控制台窗口。
        /// </summary>
        /// <param name="processId">目标进程号</param>
        /// <returns>是否隐藏成功</returns>
        private static bool HideConsoleOf(uint processId)
        {
            FreeConsole();

            bool attached = AttachConsole(processId);
            if (!attached)
            {
                return false;
            }

            IntPtr window = GetConsoleWindow();
            bool hidden = false;
            if (window != IntPtr.Zero)
            {
                hidden = ShowWindow(window, SwHide);
            }

            FreeConsole();
            return hidden;
        }
    }
}
