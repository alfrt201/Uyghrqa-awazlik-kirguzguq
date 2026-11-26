const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const path = require('path');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const { saveUyghurTrainingSample } = require('@librechat/api');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});
const trainingSampleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 1, fieldSize: 64 * 1024 },
});
const WORKER_PATH = path.join(__dirname, 'worker.py');
const MAX_TRANSCRIPTION_MS = 180_000;

let worker;
let workerReady;
let stdoutBuffer = '';
let nextId = 0;
const pending = new Map();

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function stopWorker(error) {
  const child = worker;
  worker = undefined;
  workerReady = undefined;
  stdoutBuffer = '';
  rejectPending(error);
  if (child && !child.killed) child.kill();
}

function startWorker() {
  if (workerReady) return workerReady;
  const python = process.env.UYGHUR_LOCAL_ASR_PYTHON;
  const modelPath = process.env.UYGHUR_LOCAL_ASR_MODEL_PATH;
  if (!python || !modelPath) {
    return Promise.reject(new Error('本地维吾尔语识别尚未配置。'));
  }

  worker = spawn(python, ['-u', WORKER_PATH, modelPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  const child = worker;
  workerReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopWorker(new Error('本地语音模型启动超时。'));
      reject(new Error('本地语音模型启动超时。'));
    }, 120_000);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (message.type === 'startup_error') {
          clearTimeout(timer);
          reject(new Error(message.message || '本地语音模型启动失败。'));
          stopWorker(new Error('本地语音模型启动失败。'));
        } else if (pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.text || '');
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      console.error('[UyghurLocalASR]', chunk.toString('utf8').trim());
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
      stopWorker(new Error('本地语音识别进程无法启动。'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (worker === child) {
        stopWorker(new Error(`本地语音识别进程已退出（${code ?? 'unknown'}）。`));
      }
    });
  });
  return workerReady;
}

async function transcribe(audio) {
  await startWorker();
  if (!worker || !worker.stdin.writable) throw new Error('本地语音识别进程不可用。');
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本地识别超时，请缩短录音后重试。'));
    }, MAX_TRANSCRIPTION_MS);
    pending.set(id, { resolve, reject, timer });
    worker.stdin.write(JSON.stringify({ id, audio: audio.toString('base64') }) + '\n', (error) => {
      if (error && pending.has(id)) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

router.post('/transcribe', requireJwtAuth, upload.single('audio'), async (req, res) => {
  if (process.env.UYGHUR_LOCAL_ASR_ENABLED !== 'true') {
    return res.status(503).json({ code: 'LOCAL_UYGHUR_ASR_DISABLED' });
  }
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ code: 'AUDIO_REQUIRED' });
  }
  if (!/^audio\/(webm|ogg|mp4|wav|mpeg|mp3)/i.test(req.file.mimetype || '')) {
    return res.status(415).json({ code: 'UNSUPPORTED_AUDIO_TYPE' });
  }
  try {
    const text = await transcribe(req.file.buffer);
    return res.json({ text });
  } catch (error) {
    console.error('[UyghurLocalASR] transcription failed:', error.message);
    return res.status(503).json({ code: 'LOCAL_UYGHUR_ASR_FAILED' });
  }
});

router.post(
  '/training-samples',
  requireJwtAuth,
  trainingSampleUpload.single('audio'),
  async (req, res) => {
    if (process.env.UYGHUR_LOCAL_ASR_ENABLED !== 'true') {
      return res.status(503).json({ code: 'LOCAL_UYGHUR_ASR_DISABLED' });
    }
    if (!req.file?.buffer?.length || typeof req.body?.transcript !== 'string') {
      return res.status(400).json({ code: 'TRAINING_SAMPLE_REQUIRED' });
    }
    const userId = req.user?.id?.toString?.() ?? req.user?._id?.toString?.() ?? '';
    try {
      const result = await saveUyghurTrainingSample({
        modelDirectory: process.env.UYGHUR_LOCAL_ASR_MODEL_PATH ?? '',
        userId,
        audio: req.file.buffer,
        mimeType: req.file.mimetype ?? '',
        transcript: req.body.transcript,
      });
      return res.status(201).json(result);
    } catch {
      console.error('[UyghurLocalASR] could not save an opted-in training sample.');
      return res.status(503).json({ code: 'LOCAL_UYGHUR_SAMPLE_SAVE_FAILED' });
    }
  },
);

module.exports = { router };
