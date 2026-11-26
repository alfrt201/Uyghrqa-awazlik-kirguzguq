import express from 'express';
import { randomBytes } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { RequestHandler, Router } from 'express';
import type { Server } from 'http';

const ROUTE_PATH = '/api/speech/qwen-realtime/connect';
const TICKET_TTL_MS = 30_000;
const MAX_AUDIO_MESSAGE_BYTES = 96_000;

interface QwenRealtimeOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  requireJwtAuth: RequestHandler;
}

interface TicketEntry {
  userId: string;
  expiresAt: number;
}

/**
 * Creates an authenticated server-side relay for real-time Qwen dictation.
 * The browser receives only a short-lived, one-use ticket, never the API key.
 */
export function createQwenRealtimeService({
  apiKey,
  endpoint,
  model = 'qwen3.8-omni-flash-realtime',
  requireJwtAuth,
}: QwenRealtimeOptions): { router: Router; attach: (server: Server) => void } {
  const router = express.Router();
  const tickets = new Map<string, TicketEntry>();

  router.post('/session', requireJwtAuth, (req, res) => {
    if (!apiKey || !endpoint) {
      res.status(503).json({
        code: 'QWEN_REALTIME_NOT_CONFIGURED',
        message: '实时维吾尔语输入尚未配置服务密钥或服务地址。',
      });
      return;
    }
    const user = (req as typeof req & { user?: { id?: string | number; _id?: string | number } })
      .user;
    const userId = String(user?.id ?? user?._id ?? '');
    if (!userId) {
      res.status(401).json({ code: 'UNAUTHENTICATED' });
      return;
    }
    const now = Date.now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= now) tickets.delete(ticket);
    }
    if (tickets.size >= 1000) {
      res.status(429).json({ code: 'QWEN_REALTIME_BUSY' });
      return;
    }
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { userId, expiresAt: now + TICKET_TTL_MS });
    res.json({ ticket });
  });

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 128_000 });
  websocketServer.on('connection', (client) => {
    const providerUrl = new URL(endpoint ?? '');
    providerUrl.searchParams.set('model', model);
    const provider = new WebSocket(providerUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      maxPayload: 1_000_000,
    });
    let closed = false;
    const closeBoth = (code = 1000, reason = 'closed') => {
      if (closed) return;
      closed = true;
      if (provider.readyState === WebSocket.OPEN || provider.readyState === WebSocket.CONNECTING) {
        provider.close(code, reason);
      }
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
    };

    provider.on('open', () => {
      provider.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            audio: { input: { format: { type: 'pcm', sample_rate: 16000 } } },
            turn_detection: null,
            input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          },
        }),
      );
    });
    provider.on('message', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        const event = JSON.parse(data.toString()) as { type?: string };
        const type = event.type;
        if (
          type === 'conversation.item.input_audio_transcription.delta' ||
          type === 'conversation.item.input_audio_transcription.completed' ||
          type === 'conversation.item.input_audio_transcription.failed' ||
          type === 'session.updated' ||
          type === 'error'
        ) {
          client.send(JSON.stringify(event));
        }
      } catch {
        client.send(JSON.stringify({ type: 'error', error: { message: '无效的服务响应。' } }));
      }
    });
    provider.on('error', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({ type: 'error', error: { message: 'Qwen 实时语音连接失败。' } }),
        );
      }
      closeBoth(1011, 'provider error');
    });
    provider.on('close', () => closeBoth());

    client.on('message', (data) => {
      if (
        provider.readyState !== WebSocket.OPEN ||
        Buffer.byteLength(data.toString()) > MAX_AUDIO_MESSAGE_BYTES
      ) {
        closeBoth(1009, 'audio message too large or provider unavailable');
        return;
      }
      try {
        const event = JSON.parse(data.toString()) as { type?: string; audio?: unknown };
        if (event.type === 'input_audio_buffer.append' && typeof event.audio === 'string') {
          provider.send(JSON.stringify(event));
        } else if (event.type === 'input_audio_buffer.commit') {
          provider.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        } else {
          closeBoth(1008, 'unsupported event');
        }
      } catch {
        closeBoth(1008, 'invalid event');
      }
    });
    client.on('close', () => closeBoth());
    client.on('error', () => closeBoth(1011, 'client error'));
  });

  function attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(req.url ?? '', `http://${req.headers.host}`);
      } catch {
        return;
      }
      if (requestUrl.pathname !== ROUTE_PATH) return;

      const ticket = requestUrl.searchParams.get('ticket');
      const entry = ticket ? tickets.get(ticket) : undefined;
      if (ticket) tickets.delete(ticket);
      const origin = req.headers.origin;
      let originHost: string | null = null;
      try {
        originHost = origin ? new URL(origin).host : null;
      } catch {
        originHost = null;
      }
      if (!entry || entry.expiresAt <= Date.now() || originHost !== req.headers.host) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(req, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, req);
      });
    });
  }

  return { router, attach };
}
