import { useCallback, useEffect, useRef, useState } from 'react';
import { dataService } from 'librechat-data-provider';

export interface LocalUyghurTrainingSampleDraft {
  audio: Blob;
  transcript: string;
}

export interface LocalUyghurDictation {
  active: boolean;
  processing: boolean;
  savingSample: boolean;
  pendingSample: LocalUyghurTrainingSampleDraft | null;
  start: () => Promise<void>;
  stop: () => void;
  setSampleTranscript: (transcript: string) => void;
  saveSample: () => Promise<void>;
  discardSample: () => void;
}

/** Records in the browser, then sends one clip to the on-device ASR worker. */
export default function useLocalUyghurDictation({
  methods,
  disabled,
  onError,
  onSaved,
}: {
  methods: {
    getValues: (name: 'text') => string;
    setValue: (name: 'text', value: string, options: { shouldValidate: boolean }) => void;
  };
  disabled: boolean;
  onError: (message: string) => void;
  onSaved: () => void;
}): LocalUyghurDictation {
  const [active, setActive] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [savingSample, setSavingSample] = useState(false);
  const [pendingSample, setPendingSample] = useState<LocalUyghurTrainingSampleDraft | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const baseTextRef = useRef('');
  const canceledRef = useRef(false);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setActive(false);
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }, []);

  const setSampleTranscript = useCallback((transcript: string) => {
    setPendingSample((sample) => (sample ? { ...sample, transcript } : null));
  }, []);

  const discardSample = useCallback(() => setPendingSample(null), []);

  const saveSample = useCallback(async () => {
    if (!pendingSample || !pendingSample.transcript.trim() || savingSample) return;
    setSavingSample(true);
    try {
      await dataService.saveLocalUyghurTrainingSample(
        pendingSample.audio,
        pendingSample.transcript.trim(),
      );
      setPendingSample(null);
      onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : '保存本地训练样本失败。');
    } finally {
      setSavingSample(false);
    }
  }, [onError, onSaved, pendingSample, savingSample]);

  const start = useCallback(async () => {
    if (disabled || active || processing || pendingSample) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('当前浏览器不支持录音。');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      baseTextRef.current = methods.getValues('text')?.trim() ?? '';
      chunksRef.current = [];
      canceledRef.current = false;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        releaseStream();
        onError('浏览器录音失败，请检查麦克风权限。');
      };
      recorder.onstop = async () => {
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        releaseStream();
        chunksRef.current = [];
        if (canceledRef.current) return;
        if (!audio.size) {
          onError('没有录到声音，请再试一次。');
          return;
        }
        setProcessing(true);
        try {
          const result = await dataService.transcribeLocalUyghur(audio);
          if (canceledRef.current) return;
          const transcript = result.text?.trim();
          if (!transcript) throw new Error('没有识别出内容，请说清楚一点再试。');
          methods.setValue('text', [baseTextRef.current, transcript].filter(Boolean).join(' '), {
            shouldValidate: true,
          });
          setPendingSample({ audio, transcript });
        } catch (error) {
          if (!canceledRef.current) {
            onError(error instanceof Error ? error.message : '本地维吾尔语识别失败。');
          }
        } finally {
          setProcessing(false);
        }
      };
      recorder.start(250);
      setActive(true);
    } catch (error) {
      releaseStream();
      onError(error instanceof Error ? error.message : '无法启动本地录音。');
    }
  }, [active, disabled, methods, onError, pendingSample, processing, releaseStream]);

  useEffect(
    () => () => {
      canceledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording') recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  return {
    active,
    processing,
    savingSample,
    pendingSample,
    start,
    stop,
    setSampleTranscript,
    saveSample,
    discardSample,
  };
}
