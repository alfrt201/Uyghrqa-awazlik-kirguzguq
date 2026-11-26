import { useCallback, useEffect, useRef, useState } from 'react';
import { dataService, apiBaseUrl } from 'librechat-data-provider';

interface QwenEvent {
  type?: string;
  text?: string;
  delta?: string;
  stash?: string;
  transcript?: string;
  error?: { message?: string };
}

export interface QwenRealtimeDictation {
  active: boolean;
  starting: boolean;
  elapsed: number;
  start: () => Promise<void>;
  stop: () => void;
}

/** Streams browser microphone audio to the server relay and puts live text in the composer. */
export default function useQwenRealtimeDictation({
  methods,
  disabled,
  onError,
}: {
  methods: {
    getValues: (name: 'text') => string;
    setValue: (name: 'text', value: string, options: { shouldValidate: boolean }) => void;
  };
  disabled: boolean;
  onError: (message: string) => void;
}): QwenRealtimeDictation {
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const baseTextRef = useRef('');
  const finalTextRef = useRef('');
  const partialTextRef = useRef('');
  const stoppingRef = useRef(false);

  const updateComposer = useCallback(() => {
    const liveText = [finalTextRef.current, partialTextRef.current].filter(Boolean).join(' ');
    methods.setValue('text', [baseTextRef.current, liveText].filter(Boolean).join(' '), {
      shouldValidate: true,
    });
  }, [methods]);

  const cleanup = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    gainRef.current?.disconnect();
    if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
      socketRef.current.close(1000, 'recording ended');
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (contextRef.current && contextRef.current.state !== 'closed') {
      void contextRef.current.close();
    }
    processorRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    contextRef.current = null;
    gainRef.current = null;
    socketRef.current = null;
    setActive(false);
  }, []);

  const stop = useCallback(() => {
    if (!socketRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    processorRef.current?.disconnect();
    if (socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      window.setTimeout(() => {
        socketRef.current?.close(1000, 'recording stopped');
        cleanup();
      }, 5000);
    } else {
      cleanup();
    }
  }, [cleanup]);

  const start = useCallback(async () => {
    if (disabled || active || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.WebSocket) {
        throw new Error('当前浏览器不支持麦克风实时录音。');
      }
      baseTextRef.current = methods.getValues('text')?.trim() ?? '';
      finalTextRef.current = '';
      partialTextRef.current = '';
      stoppingRef.current = false;
      const { ticket } = await dataService.createQwenRealtimeSession();
      const path = `${apiBaseUrl()}/api/speech/qwen-realtime/connect`;
      const wsUrl = new URL(path, window.location.origin);
      wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.searchParams.set('ticket', ticket);
      const socket = new WebSocket(wsUrl.toString());
      socketRef.current = socket;
      let rejectConnection: (reason: Error) => void = () => undefined;
      const connectionReady = new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        rejectConnection = reject;
      });
      let resolveSession: () => void = () => undefined;
      let rejectSession: (reason: Error) => void = () => undefined;
      const sessionReady = new Promise<void>((resolve, reject) => {
        resolveSession = resolve;
        rejectSession = reject;
      });
      socket.onmessage = (message) => {
        let event: QwenEvent;
        try {
          event = JSON.parse(String(message.data)) as QwenEvent;
        } catch {
          return;
        }
        if (event.type === 'conversation.item.input_audio_transcription.delta') {
          partialTextRef.current = `${event.text ?? event.delta ?? ''}${event.stash ?? ''}`;
          updateComposer();
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
          const transcript = event.transcript?.trim();
          if (transcript)
            finalTextRef.current = [finalTextRef.current, transcript].filter(Boolean).join(' ');
          partialTextRef.current = '';
          updateComposer();
          if (stoppingRef.current) {
            socket.close(1000, 'transcription complete');
            cleanup();
          }
        } else if (event.type === 'error') {
          rejectSession(new Error(event.error?.message ?? 'Qwen 实时语音连接失败。'));
          if (!startingRef.current) onError(event.error?.message ?? 'Qwen 实时语音连接失败。');
          cleanup();
        } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
          onError(event.error?.message ?? '这段语音没有识别成功，请再试一次。');
          cleanup();
        } else if (event.type === 'session.updated') {
          resolveSession();
        }
      };
      socket.onerror = () => {
        rejectConnection(new Error('实时语音连接失败，请检查服务地址和密钥设置。'));
        if (!startingRef.current) onError('实时语音连接失败，请检查服务地址和密钥设置。');
      };
      socket.onclose = () => {
        if (startingRef.current) {
          rejectSession(new Error('Qwen 实时语音服务已关闭连接。'));
          return;
        }
        if (!stoppingRef.current && socketRef.current === socket) {
          onError('Qwen 实时语音服务已关闭连接。');
          cleanup();
        }
      };
      await connectionReady;
      await Promise.race([
        sessionReady,
        new Promise<never>((_resolve, reject) => {
          window.setTimeout(
            () => reject(new Error('等待 Qwen 初始化超时，请检查服务地址。')),
            15000,
          );
        }),
      ]);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const muteOutput = context.createGain();
      muteOutput.gain.value = 0;
      sourceRef.current = source;
      processorRef.current = processor;
      gainRef.current = muteOutput;
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN || stoppingRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const ratio = context.sampleRate / 16000;
        const length = Math.floor(input.length / ratio);
        const pcm = new Int16Array(length);
        for (let i = 0; i < length; i++) {
          const sample = input[Math.floor(i * ratio)];
          pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) }));
      };
      source.connect(processor);
      processor.connect(muteOutput);
      muteOutput.connect(context.destination);
      setActive(true);
    } catch (error) {
      cleanup();
      const message = error instanceof Error ? error.message : '无法启动实时语音输入。';
      onError(message);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [active, cleanup, disabled, methods, onError, updateComposer]);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => cleanup, [cleanup]);

  return { active, starting, elapsed, start, stop };
}
