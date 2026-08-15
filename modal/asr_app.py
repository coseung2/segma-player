import html
import os
import re
import subprocess
import tempfile
import uuid
from urllib.parse import urlparse

import modal


APP_NAME = "aura-japanese-asr"
MODEL_ID = "litagin/anime-whisper"
MODEL_DIR = "/models/anime-whisper"
MAX_MEDIA_URL_LENGTH = 4096
MAX_TITLE_LENGTH = 240
MAX_DURATION_SECONDS = 60 * 60
MAX_VTT_BYTES = 2_000_000
JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")

app = modal.App(APP_NAME)
model_volume = modal.Volume.from_name("aura-asr-models", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "accelerate",
        "fastapi",
        "huggingface_hub",
        "soundfile",
        "torch",
        "transformers",
    )
)
auth_secret = modal.Secret.from_name("aura-asr-auth")


def safe_media_url(value):
    if not isinstance(value, str) or not value or len(value) > MAX_MEDIA_URL_LENGTH:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.fragment:
        return None
    hostname = (parsed.hostname or "").lower().strip("[]")
    if not hostname or hostname == "localhost" or hostname.endswith(".localhost"):
        return None
    if hostname in {"::1", "0.0.0.0"} or hostname.startswith(("127.", "10.", "192.168.", "169.254.")):
        return None
    if re.match(r"^172\.(?:1[6-9]|2\d|3[0-1])\.", hostname):
        return None
    if hostname.startswith(("fc", "fd", "fe80:")):
        return None
    return parsed.geturl()


def clean_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("invalid-request")
    media_value = payload.get("mediaUrl", "")
    media_url = safe_media_url(media_value.strip() if isinstance(media_value, str) else "")
    source_value = payload.get("sourceUrl", "")
    source_url = safe_media_url(source_value.strip()) if isinstance(source_value, str) and source_value.strip() else ""
    title = str(payload.get("title", "")).strip()[:MAX_TITLE_LENGTH]
    if not media_url or source_value and not source_url:
        raise ValueError("invalid-media-url")
    return {"mediaUrl": media_url, "sourceUrl": source_url, "title": title}


def origin_for(url):
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def timestamp_seconds(value):
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if not isinstance(value, (int, float)):
        return None
    return max(0.0, float(value))


def vtt_timestamp(seconds):
    total_millis = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def chunks_to_vtt(chunks):
    cues = []
    for chunk in chunks or []:
        timestamps = chunk.get("timestamp") if isinstance(chunk, dict) else None
        if not isinstance(timestamps, (list, tuple)) or len(timestamps) < 2:
            continue
        start = timestamp_seconds(timestamps[0])
        end = timestamp_seconds(timestamps[1])
        text = str(chunk.get("text", "")).strip() if isinstance(chunk, dict) else ""
        if start is None or end is None or end <= start or not text:
            continue
        text = html.escape(text.replace("-->", "→"), quote=False)
        cues.append((start, end, text))
    cues.sort(key=lambda cue: cue[0])
    lines = ["WEBVTT", ""]
    for index, (start, end, text) in enumerate(cues, start=1):
        lines.extend([str(index), f"{vtt_timestamp(start)} --> {vtt_timestamp(end)}", text, ""])
    output = "\n".join(lines)
    if len(output.encode("utf-8")) > MAX_VTT_BYTES:
        raise ValueError("subtitle-too-large")
    return output


@app.cls(
    image=image,
    gpu="L4",
    timeout=60 * 60,
    scaledown_window=300,
    volumes={"/models": model_volume},
)
class AnimeWhisperWorker:
    @modal.enter()
    def load_model(self):
        os.environ.setdefault("HF_HOME", "/models/huggingface")
        from huggingface_hub import snapshot_download

        if not os.path.exists(os.path.join(MODEL_DIR, "config.json")):
            snapshot_download(repo_id=MODEL_ID, local_dir=MODEL_DIR)

        import torch
        from transformers import pipeline

        self.pipeline = pipeline(
            "automatic-speech-recognition",
            model=MODEL_DIR,
            device="cuda",
            torch_dtype=torch.float16,
        )

    @modal.method()
    def transcribe(self, payload):
        request = clean_payload(payload)
        media_url = request["mediaUrl"]
        source_url = request["sourceUrl"]
        headers = f"Referer: {source_url}\r\nOrigin: {origin_for(source_url)}\r\n" if source_url else ""
        audio_path = os.path.join(tempfile.gettempdir(), f"aura-asr-{uuid.uuid4().hex}.wav")
        command = [
            "ffmpeg",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
        ]
        if headers:
            command.extend(["-headers", headers])
        command.extend([
            "-i",
            media_url,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-t",
            str(MAX_DURATION_SECONDS),
            "-f",
            "wav",
            audio_path,
        ])
        try:
            subprocess.run(command, check=True, timeout=MAX_DURATION_SECONDS + 120, capture_output=True)
            import soundfile as sf

            audio, sample_rate = sf.read(audio_path, dtype="float32")
            result = self.pipeline(
                {"array": audio, "sampling_rate": sample_rate},
                chunk_length_s=30,
                stride_length_s=(5, 2),
                return_timestamps=True,
                generate_kwargs={"language": "japanese", "task": "transcribe", "no_repeat_ngram_size": 5},
            )
            vtt = chunks_to_vtt(result.get("chunks", []))
            return {"ok": True, "vtt": vtt, "title": request["title"], "model": MODEL_ID}
        finally:
            try:
                os.remove(audio_path)
            except FileNotFoundError:
                pass


def authorized(request):
    expected = os.environ.get("MODAL_ASR_TOKEN", "")
    actual = request.headers.get("authorization", "")
    return bool(expected) and actual == f"Bearer {expected}"


def response(body, status=200):
    from fastapi.responses import JSONResponse

    return JSONResponse(body, status_code=status, headers={"cache-control": "no-store"})


@app.function(image=image, secrets=[auth_secret], timeout=60 * 60)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.post("/submit")
    async def submit(request: Request):
        if not authorized(request):
            return response({"ok": False, "error": "unauthorized"}, 401)
        payload = await request.json()
        try:
            clean_payload(payload)
        except ValueError as error:
            return response({"ok": False, "error": str(error)}, 400)
        call = AnimeWhisperWorker().transcribe.spawn(payload)
        return response({"ok": True, "jobId": call.object_id}, 202)

    @api.get("/result/{job_id}")
    async def result(job_id: str, request: Request):
        if not authorized(request):
            return response({"ok": False, "error": "unauthorized"}, 401)
        if not JOB_ID_RE.fullmatch(job_id):
            return response({"ok": False, "error": "invalid-job-id"}, 400)
        try:
            call = modal.FunctionCall.from_id(job_id)
            value = call.get(timeout=0)
        except TimeoutError:
            return response({"ok": True, "status": "running"}, 202)
        except Exception:
            return response({"ok": False, "error": "job-failed"}, 500)
        return response({"ok": True, "status": "completed", "result": value})

    return api
