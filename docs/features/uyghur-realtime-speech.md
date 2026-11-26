# Qwen 实时维吾尔语语音输入

LibreChat 聊天输入框提供一个独立的实时语音按钮。说话时，识别到的文字会逐步写入输入框；停止后可以检查、修改，再像普通消息一样发送给当前选择的智能体。

## 配置

在运行 LibreChat 服务端的 `.env` 文件中填写：

```dotenv
DASHSCOPE_API_KEY=你的DashScope密钥
DASHSCOPE_REALTIME_URL=wss://你的工作空间.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime
QWEN_REALTIME_MODEL=qwen3.8-omni-flash-realtime
```

`DASHSCOPE_REALTIME_URL` 要使用你在阿里云 DashScope 控制台和之前测试时对应的区域、工作空间地址。不要把密钥放入浏览器代码或提交到 Git。修改环境变量后重启 LibreChat 服务端。

## 使用

1. 在支持麦克风的浏览器中打开 LibreChat。浏览器要求通过 HTTPS 或本机 `localhost` 访问麦克风。
2. 在聊天输入框旁选择“Start live Uyghur transcription”麦克风按钮，并允许浏览器使用麦克风。
3. 维吾尔语文字会出现在输入框；点击停止后核对内容，再按常规发送按钮。

若没有配置密钥或服务地址，点击按钮后服务端会返回未配置提示。已有的普通语音输入按钮继续保留。

## 本地离线识别（Mac）

源码包提供了第二个按钮“本地维吾尔语输入”。它不连接 Qwen 或讯飞：浏览器录完一段音频后，把录音发送给本机 Python 识别进程，识别出的文字再放进输入框。它是“录完再识别”，不是逐字实时字幕。

首次部署需要 Python 3.11 或更新版本、`faster-whisper` / CTranslate2，以及单独放在本机数据目录中的模型文件。后端只接受登录用户的音频请求，并限制录音大小；Python 进程通过标准输入读取音频，不将录音写入临时文件。识别历史不会由这项本地功能另行保存。

在服务端 `.env` 中设置：

```dotenv
UYGHUR_LOCAL_ASR_ENABLED=true
UYGHUR_LOCAL_ASR_PYTHON=/本机路径/venv/bin/python
UYGHUR_LOCAL_ASR_MODEL_PATH=/本机路径/ct2-small-ug-int8
```

Mac 上当前以 CPU `int8` 运行；录音结束后才开始转写。第一次使用可能需要等待模型加载。实际速度和识别准确率取决于 Mac 性能、麦克风与说话方式，部署后应以用户的真实录音验收。

## 自愿收集训练样本

本地识别完成后，可以在聊天输入框下方核对这段录音对应的维吾尔文。只有点击“保存本地样本”时，服务端才会把原录音和当前校对文字保存到模型文件夹旁的 `training-data/` 目录；点击“丢弃”或离开页面则不保存。一次只保留一段待处理录音，保存或丢弃后才能继续录音。

Mac 默认目录为 `~/Library/Application Support/LibreChat/UyghurASR/training-data/`。样本按登录用户分开保存，目录权限仅当前电脑账户可读写。样本包括音频和校对文字，可能包含私人谈话；只保存你有权留存的内容。

保存样本不会自动训练或替换识别模型。后续需要积累足够的准确样本，单独留出一部分录音评估新模型，再确认准确率有改善后才适合切换。
