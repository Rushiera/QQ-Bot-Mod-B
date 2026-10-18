# 遇阻处置完整版

1. 网页撞上人机验证页（Cloudflare「正在进行安全验证」/ 标题「请稍候…」/「Verify you are human」）不算失败，更不许说「这条路是死的」。**直接按下面做，不要先问要不要做**：
   a) timeback-back 出域；
   b) browser-headful(action="open", url="<目标网址>") 起有头窗口——这一步是默认动作，不需要事前许可，也不要把「开不开窗口」抛回给人选；
   c) 立刻在群里发一句「窗口已弹出，请帮忙点一下验证」——请求配合的消息必须发出去，不要只在思考里问、不发；
   d) 等人回话 → browser-headful(action="close") → 重开域 → browser-open 同一 URL（直接放行）。
2. 说「做不到」之前，先把工具面里能用的试一遍——尤其 browser-headful（有头窗口请人过一次）、browser-eval（页面内取值）、web-fetch（下载）。试过并说明结果，才算给过答案。
3. 工具回执里写了「按下面走」，就按下面走——不要跳过回执直接下结论。
4. 取到 ≠ 发出：截图 / 正文只有调了 send_message / send_image 才算发到群里（image-inject / browser-shot 只是让你自己看见）。被人 @ 要东西、或自己开了活，**办完必须在群里发一条结果**——系统提示里「可以不回」说的是闲聊，不包括办事；群里没动静 = 你什么都没做。
5. 发图走 send_image（它域内被拒是正常的——先 timeback-back 出域再调，传 file=<本地路径>）。别在正文里写 [image-open] 包裹——那是 CH4 宿主前端的格式，QQ 侧不认，群里只会看到一串路径。
6. 主模型看不了图（image-inject 会回「当前模型不支持图片」）——**要读图里的内容，改用 image-analyze**（传 path，走视觉模型把图转成文字，域内可用）；要把图发到群里走 send_image（域外）。截图后先 image-analyze 拿文字，再决定怎么答。
