"""Private stdio worker for local Uyghur speech transcription."""

from __future__ import annotations

import base64
import io
import json
import sys
import unicodedata
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    if len(sys.argv) != 2:
        emit({"type": "startup_error", "message": "模型路径未配置。"})
        return 2
    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
        from ug_text import normalize_uig, uly_to_uig

        model_path = Path(sys.argv[1]).expanduser().resolve()
        if not model_path.is_dir():
            raise FileNotFoundError("本地维吾尔语模型文件夹不存在。")
        model = WhisperModel(str(model_path), device="cpu", compute_type="int8")
    except Exception as error:
        emit({"type": "startup_error", "message": f"{type(error).__name__}: {error}"})
        return 1

    emit({"type": "ready"})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            audio_bytes = base64.b64decode(request["audio"], validate=True)
            if not audio_bytes or len(audio_bytes) > 12 * 1024 * 1024:
                raise ValueError("音频为空或超过大小限制。")
            samples = decode_audio(io.BytesIO(audio_bytes), sampling_rate=16000)
            if len(samples) > 16000 * 120:
                raise ValueError("录音不能超过 120 秒。")
            segments, _info = model.transcribe(
                samples,
                language="en",
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400},
                condition_on_previous_text=False,
            )
            raw = "".join(segment.text for segment in segments).strip()
            letters = [char for char in raw if unicodedata.category(char).startswith("L")]
            arabic_ratio = (
                sum("\u0600" <= char <= "\u06ff" for char in letters) / len(letters)
                if letters
                else 0
            )
            text = raw if arabic_ratio > 0.5 else normalize_uig(uly_to_uig(raw))
            emit({"id": request.get("id"), "text": text})
        except Exception as error:
            emit({"id": request.get("id") if "request" in locals() else None,
                  "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
