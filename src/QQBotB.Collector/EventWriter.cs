using System;
using System.IO;
using System.Text;

namespace QQBotB.Collector
{
    /// <summary>
    /// 事件落盘器——按天分文件的 JSONL 追加写入。
    /// </summary>
    internal sealed class EventWriter
    {
        private readonly string _outputDir;
        private readonly object _gate;

        /// <summary>
        /// 构造落盘器。
        /// </summary>
        /// <param name="outputDir">落盘根目录（不存在则自动创建）。</param>
        public EventWriter(string outputDir)
        {
            _outputDir = outputDir;
            _gate = new object();
            if (Directory.Exists(outputDir) == false)
            {
                Directory.CreateDirectory(outputDir);
            }
        }

        /// <summary>
        /// 追加一条事件记录。
        /// </summary>
        /// <param name="json">OneBot 原始事件 JSON 文本。</param>
        /// <returns>实际落盘的文件全路径。</returns>
        public string Append(string json)
        {
            // [段1] 组装记录行（外层加接收时刻）
            string timestamp = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz");
            StringBuilder builder = new StringBuilder();
            builder.Append("{\"receivedAt\":\"");
            builder.Append(timestamp);
            builder.Append("\",\"raw\":");
            builder.Append(json);
            builder.Append("}");
            string line = builder.ToString();

            // [段2] 按天定文件并追加
            string fileName = "events-" + DateTime.Now.ToString("yyyyMMdd") + ".jsonl";
            string fullPath = Path.Combine(_outputDir, fileName);

            lock (_gate)
            {
                File.AppendAllText(fullPath, line + Environment.NewLine, Encoding.UTF8);
            }

            return fullPath;
        }
    }
}
