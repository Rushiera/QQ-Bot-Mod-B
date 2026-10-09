using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace QQBotB.Collector
{
    /// <summary>
    /// OneBot 11 正向 WebSocket 客户端——连接协议端并持续收集事件。
    /// </summary>
    internal sealed class OneBotWsClient
    {
        private const int BufferSize = 65536;
        private const int ReconnectDelayMs = 3000;

        private readonly Uri _endpoint;
        private readonly string _token;
        private readonly EventWriter _writer;

        /// <summary>
        /// 构造客户端。
        /// </summary>
        /// <param name="wsUrl">协议端正向 WebSocket 地址。</param>
        /// <param name="token">访问令牌。</param>
        /// <param name="writer">事件落盘器。</param>
        public OneBotWsClient(string wsUrl, string token, EventWriter writer)
        {
            _endpoint = new Uri(wsUrl);
            _token = token;
            _writer = writer;
        }

        /// <summary>
        /// 运行收集循环——断线自动重连，直到收到取消信号。
        /// </summary>
        /// <param name="cancel">取消令牌。</param>
        public async Task RunAsync(CancellationToken cancel)
        {
            while (cancel.IsCancellationRequested == false)
            {
                try
                {
                    await ConnectAndPumpAsync(cancel);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("ERROR | 连接异常 | " + ex.GetType().Name + " | " + ex.Message);
                }

                if (cancel.IsCancellationRequested)
                {
                    break;
                }

                Console.WriteLine("WARN | 等待重连 | " + ReconnectDelayMs.ToString() + " 毫秒");
                await Task.Delay(ReconnectDelayMs, cancel);
            }
        }

        /// <summary>
        /// 建立连接并持续接收消息帧。
        /// </summary>
        /// <param name="cancel">取消令牌。</param>
        private async Task ConnectAndPumpAsync(CancellationToken cancel)
        {
            // [段1] 建立连接
            using (ClientWebSocket socket = new ClientWebSocket())
            {
                socket.Options.SetRequestHeader("Authorization", "Bearer " + _token);
                await socket.ConnectAsync(_endpoint, cancel);
                Console.WriteLine("INFO | 已连接 | " + _endpoint.ToString());

                // [段2] 接收循环
                byte[] buffer = new byte[BufferSize];
                using (MemoryStream pending = new MemoryStream())
                {
                    while (socket.State == WebSocketState.Open && cancel.IsCancellationRequested == false)
                    {
                        ValueWebSocketReceiveResult result = await socket.ReceiveAsync(new Memory<byte>(buffer), cancel);

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            Console.WriteLine("WARN | 协议端关闭连接 | " + socket.CloseStatusDescription);
                            break;
                        }

                        pending.Write(buffer, 0, result.Count);

                        if (result.EndOfMessage)
                        {
                            string json = Encoding.UTF8.GetString(pending.ToArray());
                            pending.SetLength(0);
                            string path = _writer.Append(json);
                            Console.WriteLine("INFO | 事件落盘 | " + path + " | " + json.Length.ToString() + " 字符");
                        }
                    }
                }

                // [段3] 收尾
                if (socket.State == WebSocketState.Open)
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", cancel);
                }
            }
        }
    }
}
