using System;
using System.Threading;
using System.Threading.Tasks;

namespace QQBotB.Collector
{
    /// <summary>
    /// 程序入口——解析参数并驱动 OneBot 事件收集循环。
    /// </summary>
    internal static class Program
    {
        /// <summary>
        /// 进程入口。
        /// </summary>
        /// <param name="args">参数：wsUrl token [outputDir]。</param>
        /// <returns>退出码——0 正常结束，1 参数缺失。</returns>
        private static async Task<int> Main(string[] args)
        {
            // [段1] 解析参数
            if (args.Length < 2)
            {
                Console.WriteLine("用法：QQBotB.Collector <wsUrl> <token> [outputDir]");
                Console.WriteLine("示例：QQBotB.Collector ws://127.0.0.1:3001 napcatb2405997337 events");
                return 1;
            }

            string wsUrl = args[0];
            string token = args[1];
            string outputDir = "events";
            if (args.Length > 2)
            {
                outputDir = args[2];
            }

            // [段2] 组装收集链
            EventWriter writer = new EventWriter(outputDir);
            OneBotWsClient client = new OneBotWsClient(wsUrl, token, writer);

            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("INFO | 启动收集 | " + wsUrl + " | " + outputDir);

            // [段3] 运行至取消
            using (CancellationTokenSource source = new CancellationTokenSource())
            {
                ConsoleCancelEventHandler handler = delegate(object? sender, ConsoleCancelEventArgs e)
                {
                    e.Cancel = true;
                    source.Cancel();
                };
                Console.CancelKeyPress += handler;

                await client.RunAsync(source.Token);

                Console.CancelKeyPress -= handler;
            }

            Console.WriteLine("INFO | 收集结束");
            return 0;
        }
    }
}
