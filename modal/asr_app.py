import html
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import unquote, urljoin, urlparse

import modal


APP_NAME = "aura-japanese-asr"
MODEL_ID = "litagin/anime-whisper"
MODEL_DIR = "/models/anime-whisper"
ENGLISH_ASR_MODEL_ID = "openai/whisper-large-v3-turbo"
ENGLISH_ASR_MODEL_DIR = "/models/whisper-large-v3-turbo"
TRANSLATION_MODEL_ID = "google/translategemma-12b-it"
TRANSLATION_MODEL_DIR = "/models/translategemma-12b-it"
MAX_MEDIA_URL_LENGTH = 4096
MAX_TITLE_LENGTH = 240
MAX_DURATION_SECONDS = 60 * 60
MAX_VTT_BYTES = 2_000_000
MAX_AUDIO_UPLOAD_BYTES = 80 * 1024 * 1024
AUDIO_JOB_MAX_AGE_SECONDS = 2 * 60 * 60
AUDIO_JOB_DIR = "/audio-jobs"
JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
AUDIO_JOB_PATH_RE = re.compile(r"^/audio-jobs/[a-f0-9]{32}\.(?:input|wav)$")
ALLOWED_AUDIO_UPLOAD_CONTENT_TYPES = {
    "application/octet-stream",
    "audio/aac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "video/mp2t",
}
MEDIA_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def media_log(message):
    print(f"[aura-asr-media] {message}", flush=True)

app = modal.App(APP_NAME)
model_volume = modal.Volume.from_name("aura-asr-models", create_if_missing=True)
audio_job_volume = modal.Volume.from_name(
    "aura-asr-audio-jobs",
    create_if_missing=True,
    version=2,
)
job_progress = modal.Dict.from_name("aura-asr-job-progress", create_if_missing=True)
ingest_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ffmpeg")
    .pip_install("fastapi")
)
image = ingest_image.pip_install(
    "accelerate",
    "bitsandbytes",
    "huggingface_hub",
    "Pillow",
    "soundfile",
    "torch",
    "torchvision",
    "transformers",
)
auth_secret = modal.Secret.from_name("aura-asr-auth")
huggingface_secret = modal.Secret.from_name("huggingface")


def safe_media_url(value):
    if not isinstance(value, str) or not value or len(value) > MAX_MEDIA_URL_LENGTH:
        return None
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
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
    source_language = str(payload.get("sourceLanguage", "ja")).strip().lower()
    if not media_url or source_value and not source_url:
        raise ValueError("invalid-media-url")
    if source_language not in {"ja", "en"}:
        raise ValueError("invalid-source-language")
    progress_key = str(payload.get("progressKey", "")).strip()
    if progress_key and not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", progress_key):
        raise ValueError("invalid-progress-key")
    return {
        "mediaUrl": media_url,
        "sourceUrl": source_url,
        "title": title,
        "sourceLanguage": source_language,
        "progressKey": progress_key,
    }


def clean_audio_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("invalid-request")
    audio_path = str(payload.get("audioPath", "")).strip()
    title = str(payload.get("title", "")).strip()[:MAX_TITLE_LENGTH]
    source_language = str(payload.get("sourceLanguage", "ja")).strip().lower()
    progress_key = str(payload.get("progressKey", "")).strip()
    if not AUDIO_JOB_PATH_RE.fullmatch(audio_path):
        raise ValueError("invalid-audio-path")
    if source_language not in {"ja", "en"}:
        raise ValueError("invalid-source-language")
    if progress_key and not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", progress_key):
        raise ValueError("invalid-progress-key")
    return {
        "audioPath": audio_path,
        "title": title,
        "sourceLanguage": source_language,
        "progressKey": progress_key,
    }


def audio_job_paths(token=None):
    job_token = token or uuid.uuid4().hex
    if not re.fullmatch(r"[a-f0-9]{32}", job_token):
        raise ValueError("invalid-audio-job-token")
    return (
        os.path.join(AUDIO_JOB_DIR, f"{job_token}.input"),
        os.path.join(AUDIO_JOB_DIR, f"{job_token}.wav"),
    )


def remove_audio_job_files(*paths):
    changed = False
    for path in paths:
        if not AUDIO_JOB_PATH_RE.fullmatch(str(path or "")):
            continue
        try:
            os.remove(path)
            changed = True
        except FileNotFoundError:
            pass
    if changed:
        audio_job_volume.commit()


def prune_audio_job_files(now=None):
    current = float(now if now is not None else time.time())
    changed = False
    try:
        names = os.listdir(AUDIO_JOB_DIR)
    except FileNotFoundError:
        return 0
    removed = 0
    for name in names:
        path = os.path.join(AUDIO_JOB_DIR, name)
        if not AUDIO_JOB_PATH_RE.fullmatch(path):
            continue
        try:
            age = current - os.stat(path).st_mtime
        except FileNotFoundError:
            continue
        if age < AUDIO_JOB_MAX_AGE_SECONDS:
            continue
        try:
            os.remove(path)
            changed = True
            removed += 1
        except FileNotFoundError:
            pass
    if changed:
        audio_job_volume.commit()
    return removed


def set_job_progress(progress_key, phase, progress, completed=0, total=0):
    if not progress_key:
        return
    job_progress[progress_key] = {
        "phase": phase,
        "progress": max(0, min(100, int(progress))),
        "completed": max(0, int(completed)),
        "total": max(0, int(total)),
        "updatedAt": int(time.time()),
    }


def origin_for(url):
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def pinned_public_resolution(url):
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        }
        parsed_addresses = [ipaddress.ip_address(value) for value in addresses]
    except (OSError, ValueError):
        raise ValueError("media-host-unavailable")
    if not parsed_addresses or any(not address.is_global for address in parsed_addresses):
        raise ValueError("invalid-media-host")
    address = str(sorted(parsed_addresses, key=lambda value: (value.version, str(value)))[0])
    if ":" in address:
        address = f"[{address}]"
    return ["--resolve", f"{hostname}:{port}:{address}"]


def media_input_error(error):
    stderr = error.stderr.decode("utf-8", "replace") if isinstance(error.stderr, bytes) else str(error.stderr or "")
    lowered = stderr.lower()
    if "403" in lowered or "forbidden" in lowered or "access denied" in lowered:
        return "media-source-access-denied"
    return "media-source-unavailable"


def curl_headers(source_url, media_url):
    referer = source_url or media_url
    origin = origin_for(source_url) if source_url else origin_for(media_url)
    return [
        "--user-agent",
        MEDIA_USER_AGENT,
        "--referer",
        referer,
        "--header",
        f"Origin: {origin}",
    ]


def curl_download(url, output_path, source_url):
    command = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--compressed",
        "--noproxy",
        "*",
        "--http1.1",
        "--retry",
        "2",
        "--connect-timeout",
        "20",
        "--max-time",
        str(MAX_DURATION_SECONDS + 120),
        *pinned_public_resolution(url),
        *curl_headers(source_url, url),
        "--output",
        output_path,
        url,
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            timeout=MAX_DURATION_SECONDS + 180,
            capture_output=True,
        )
        return result
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip().replace("\n", " ")[-240:]
        media_log(f"curl failed code={error.returncode} detail={detail}")
        raise


def curl_text(url, source_url):
    command = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--compressed",
        "--noproxy",
        "*",
        "--http1.1",
        "--retry",
        "2",
        "--connect-timeout",
        "20",
        "--max-time",
        "60",
        *pinned_public_resolution(url),
        *curl_headers(source_url, url),
        url,
    ]
    try:
        result = subprocess.run(command, check=True, timeout=90, capture_output=True)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip().replace("\n", " ")[-240:]
        media_log(f"playlist curl failed code={error.returncode} detail={detail}")
        raise
    text = result.stdout.decode("utf-8-sig", "replace")
    if len(text.encode("utf-8")) > 10_000_000:
        raise ValueError("media-playlist-too-large")
    return text


def hls_uri(line):
    match = re.search(r'URI="([^"]+)"', line, re.IGNORECASE)
    return match.group(1) if match else None


def hls_variant(text, playlist_url):
    lines = text.splitlines()
    variants = []
    for index, line in enumerate(lines):
        if not line.upper().startswith("#EXT-X-STREAM-INF"):
            continue
        uri = next((value.strip() for value in lines[index + 1:] if value.strip() and not value.startswith("#")), None)
        if not uri:
            continue
        bandwidth = re.search(r"BANDWIDTH=(\d+)", line, re.IGNORECASE)
        variants.append((int(bandwidth.group(1)) if bandwidth else 0, urljoin(playlist_url, uri)))
    return max(variants, key=lambda item: item[0])[1] if variants else None


def materialize_hls(media_url, source_url, workdir):
    playlist_url = media_url
    playlist = curl_text(playlist_url, source_url)
    for _ in range(3):
        variant_url = hls_variant(playlist, playlist_url)
        if not variant_url:
            break
        playlist_url = variant_url
        playlist = curl_text(playlist_url, source_url)
    if "#EXTM3U" not in playlist.upper():
        raise ValueError("media-playlist-invalid")

    lines = playlist.splitlines()
    resources = []
    rewritten = []
    segment_count = 0
    duration = 0.0
    stop_after_segment = False
    for line in lines:
        stripped = line.strip()
        if stop_after_segment:
            continue
        if stripped.upper().startswith("#EXTINF:"):
            match = re.match(r"#EXTINF:([0-9.]+)", stripped, re.IGNORECASE)
            if match:
                duration += float(match.group(1))
            rewritten.append(line)
            continue
        if stripped and not stripped.startswith("#"):
            segment_count += 1
            if segment_count > 1 and duration > MAX_DURATION_SECONDS:
                stop_after_segment = True
                continue
            resource_url = urljoin(playlist_url, stripped)
            if not safe_media_url(resource_url):
                raise ValueError("invalid-hls-resource")
            filename = f"segment-{segment_count:05d}.bin"
            resources.append((resource_url, os.path.join(workdir, filename)))
            rewritten.append(filename)
            continue
        uri = hls_uri(stripped) if stripped.startswith("#EXT-X-KEY") or stripped.startswith("#EXT-X-MAP") else None
        if uri:
            resource_url = urljoin(playlist_url, uri)
            if not safe_media_url(resource_url):
                raise ValueError("invalid-hls-resource")
            filename = f"resource-{len(resources) + 1:05d}.bin"
            resources.append((resource_url, os.path.join(workdir, filename)))
            rewritten.append(stripped.replace(f'URI="{uri}"', f'URI="{filename}"'))
        else:
            rewritten.append(line)

    if not resources or segment_count == 0:
        raise ValueError("media-playlist-empty")
    media_log(f"hls materialize segments={segment_count} resources={len(resources)}")
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(curl_download, url, path, source_url or playlist_url) for url, path in resources]
        for future in futures:
            future.result()
    local_playlist = os.path.join(workdir, "input.m3u8")
    with open(local_playlist, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(rewritten) + "\n#EXT-X-ENDLIST\n")
    return local_playlist


def browser_fingerprint_media(media_url, source_url):
    workdir = tempfile.mkdtemp(prefix="aura-asr-media-")
    downloaded = os.path.join(workdir, "download.bin")
    try:
        if re.search(r"\.m3u8(?:$|[?#])", media_url, re.IGNORECASE):
            media_log("curl fallback mode=hls")
            return workdir, materialize_hls(media_url, source_url, workdir)
        media_log("curl fallback mode=progressive")
        curl_download(media_url, downloaded, source_url)
        with open(downloaded, "rb") as handle:
            prefix = handle.read(256).lstrip()
        if prefix.upper().startswith(b"#EXTM3U"):
            media_log("curl fallback detected=hls")
            return workdir, materialize_hls(media_url, source_url, workdir)
        media_log("curl fallback downloaded=progressive")
        return workdir, downloaded
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def audio_extract_command(input_path, audio_path, headers="", remote=False, allow_all_extensions=False):
    command = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
    ]
    if remote:
        command.extend([
            "-user_agent",
            MEDIA_USER_AGENT,
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto,data",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
        ])
    if headers:
        command.extend(["-headers", headers])
    if allow_all_extensions:
        command.extend(["-allowed_extensions", "ALL"])
    command.extend([
        "-i",
        input_path,
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
    return command


def normalize_uploaded_audio(input_path, audio_path):
    if not AUDIO_JOB_PATH_RE.fullmatch(input_path) or not AUDIO_JOB_PATH_RE.fullmatch(audio_path):
        raise ValueError("invalid-audio-path")
    subprocess.run(
        audio_extract_command(input_path, audio_path),
        check=True,
        timeout=MAX_DURATION_SECONDS + 180,
        capture_output=True,
    )


def extract_remote_audio(request, audio_path):
    media_url = request["mediaUrl"]
    source_url = request["sourceUrl"]
    progress_key = request["progressKey"]
    media_workdir = None
    try:
        set_job_progress(progress_key, "extracting-audio", 5)
        media_workdir, local_media = browser_fingerprint_media(media_url, source_url)
        try:
            subprocess.run(
                audio_extract_command(local_media, audio_path, allow_all_extensions=True),
                check=True,
                timeout=MAX_DURATION_SECONDS + 180,
                capture_output=True,
            )
        except subprocess.CalledProcessError as error:
            detail = error.stderr.decode("utf-8", "replace").strip().replace("\n", " ")[-320:]
            media_log(f"local ffmpeg failed code={error.returncode} detail={detail}")
            raise
    finally:
        if media_workdir:
            shutil.rmtree(media_workdir, ignore_errors=True)


async def put_job_progress(progress_key, value):
    if progress_key:
        await job_progress.put.aio(progress_key, value)


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
    volumes={
        "/models": model_volume,
        AUDIO_JOB_DIR: audio_job_volume.with_mount_options(read_only=True),
    },
    secrets=[huggingface_secret],
)
class AnimeWhisperWorker:
    @modal.enter()
    def load_model(self):
        os.environ.setdefault("HF_HOME", "/models/huggingface")
        from huggingface_hub import snapshot_download

        huggingface_token = (
            os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGINGFACE_HUB_TOKEN")
            or os.environ.get("HUGGINGFACE_TOKEN")
            or None
        )
        downloaded_models = False
        if not os.path.exists(os.path.join(MODEL_DIR, "config.json")):
            snapshot_download(repo_id=MODEL_ID, local_dir=MODEL_DIR, token=huggingface_token)
            downloaded_models = True
        if not os.path.exists(os.path.join(ENGLISH_ASR_MODEL_DIR, "config.json")):
            snapshot_download(repo_id=ENGLISH_ASR_MODEL_ID, local_dir=ENGLISH_ASR_MODEL_DIR, token=huggingface_token)
            downloaded_models = True
        if not os.path.exists(os.path.join(TRANSLATION_MODEL_DIR, "config.json")):
            snapshot_download(
                repo_id=TRANSLATION_MODEL_ID,
                local_dir=TRANSLATION_MODEL_DIR,
                token=huggingface_token,
            )
            downloaded_models = True
        if downloaded_models:
            model_volume.commit()

        import torch
        from transformers import (
            AutoModelForImageTextToText,
            AutoProcessor,
            BitsAndBytesConfig,
            pipeline,
        )

        self.japanese_pipeline = pipeline(
            "automatic-speech-recognition",
            model=MODEL_DIR,
            device="cuda",
            torch_dtype=torch.float16,
        )
        self.english_pipeline = None
        translation_quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        self.translation_processor = AutoProcessor.from_pretrained(
            TRANSLATION_MODEL_DIR,
            token=huggingface_token,
        )
        self.translation_model = AutoModelForImageTextToText.from_pretrained(
            TRANSLATION_MODEL_DIR,
            device_map="auto",
            quantization_config=translation_quantization,
            torch_dtype=torch.bfloat16,
            token=huggingface_token,
        ).eval()

    def english_asr_pipeline(self):
        if self.english_pipeline is None:
            import torch
            from transformers import pipeline

            self.english_pipeline = pipeline(
                "automatic-speech-recognition",
                model=ENGLISH_ASR_MODEL_DIR,
                device="cuda",
                torch_dtype=torch.float16,
            )
        return self.english_pipeline

    def translate_text(self, text, source_language):
        source = str(text or "").strip()
        if not source:
            return source
        messages = [{
            "role": "user",
            "content": [{
                "type": "text",
                "source_lang_code": source_language,
                "target_lang_code": "ko",
                "text": source,
            }],
        }]
        inputs = self.translation_processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self.translation_model.device)
        prompt_tokens = inputs["input_ids"].shape[-1]
        with __import__("torch").inference_mode():
            output = self.translation_model.generate(
                **inputs,
                max_new_tokens=min(512, max(64, len(source) * 3)),
                do_sample=False,
            )
        translated = self.translation_processor.decode(
            output[0][prompt_tokens:],
            skip_special_tokens=True,
        ).strip()
        if not translated:
            raise ValueError("translation-empty")
        return translated

    def translate_chunks(self, chunks, source_language, progress_key=""):
        translated = []
        valid_chunks = [chunk for chunk in chunks or [] if isinstance(chunk, dict)]
        total = len(valid_chunks)
        for index, chunk in enumerate(valid_chunks, start=1):
            next_chunk = dict(chunk)
            next_chunk["text"] = self.translate_text(next_chunk.get("text", ""), source_language)
            translated.append(next_chunk)
            set_job_progress(progress_key, "translating", 60 + int((index / max(1, total)) * 38), index, total)
        return translated

    @modal.method()
    def transcribe_audio(self, payload):
        request = clean_audio_payload(payload)
        audio_job_volume.reload()
        audio_path = request["audioPath"]
        if not os.path.isfile(audio_path):
            return {"ok": False, "error": "audio-input-missing"}

        import soundfile as sf

        audio, sample_rate = sf.read(audio_path, dtype="float32")
        source_language = request["sourceLanguage"]
        progress_key = request["progressKey"]
        set_job_progress(progress_key, "transcribing", 15)
        asr_pipeline = self.japanese_pipeline if source_language == "ja" else self.english_asr_pipeline()
        asr_model_id = MODEL_ID if source_language == "ja" else ENGLISH_ASR_MODEL_ID
        result = asr_pipeline(
            {"array": audio, "sampling_rate": sample_rate},
            chunk_length_s=30,
            stride_length_s=(5, 2),
            return_timestamps=True,
            generate_kwargs={
                "language": "japanese" if source_language == "ja" else "english",
                "task": "transcribe",
                "no_repeat_ngram_size": 5,
            },
        )
        set_job_progress(progress_key, "translating", 60)
        vtt = chunks_to_vtt(self.translate_chunks(result.get("chunks", []), source_language, progress_key))
        set_job_progress(progress_key, "finalizing", 99)
        return {
            "ok": True,
            "vtt": vtt,
            "title": request["title"],
            "model": f"{asr_model_id}+{TRANSLATION_MODEL_ID}",
            "sourceLanguage": source_language,
        }


@app.function(
    image=ingest_image,
    cpu=2.0,
    memory=1024,
    timeout=60 * 60,
    volumes={AUDIO_JOB_DIR: audio_job_volume},
)
def ingest_url_job(payload):
    request = clean_payload(payload)
    _, audio_path = audio_job_paths()
    audio_job_volume.reload()
    prune_audio_job_files()
    try:
        extract_remote_audio(request, audio_path)
        audio_job_volume.commit()
        return AnimeWhisperWorker().transcribe_audio.remote({
            "audioPath": audio_path,
            "title": request["title"],
            "sourceLanguage": request["sourceLanguage"],
            "progressKey": request["progressKey"],
        })
    except subprocess.CalledProcessError as error:
        return {"ok": False, "error": media_input_error(error)}
    finally:
        remove_audio_job_files(audio_path)


@app.function(
    image=ingest_image,
    cpu=2.0,
    memory=1024,
    timeout=60 * 60,
    volumes={AUDIO_JOB_DIR: audio_job_volume},
)
def ingest_uploaded_audio_job(payload):
    input_path = str(payload.get("inputPath", "")).strip() if isinstance(payload, dict) else ""
    request = clean_audio_payload(payload)
    if not input_path.endswith(".input") or not AUDIO_JOB_PATH_RE.fullmatch(input_path):
        raise ValueError("invalid-audio-path")
    audio_job_volume.reload()
    prune_audio_job_files()
    if not os.path.isfile(input_path):
        return {"ok": False, "error": "audio-input-missing"}
    try:
        set_job_progress(request["progressKey"], "extracting-audio", 8)
        normalize_uploaded_audio(input_path, request["audioPath"])
        audio_job_volume.commit()
        return AnimeWhisperWorker().transcribe_audio.remote(request)
    except subprocess.CalledProcessError:
        return {"ok": False, "error": "invalid-audio-upload"}
    finally:
        remove_audio_job_files(input_path, request["audioPath"])


def authorized(request):
    expected = os.environ.get("MODAL_ASR_TOKEN", "")
    actual = request.headers.get("authorization", "")
    return bool(expected) and actual == f"Bearer {expected}"


def response(body, status=200):
    from fastapi.responses import JSONResponse

    return JSONResponse(body, status_code=status, headers={"cache-control": "no-store"})


@app.function(
    image=ingest_image,
    secrets=[auth_secret],
    memory=512,
    timeout=60 * 60,
    volumes={AUDIO_JOB_DIR: audio_job_volume},
)
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
        progress_key = uuid.uuid4().hex
        payload["progressKey"] = progress_key
        await put_job_progress(progress_key, {
            "phase": "queued",
            "progress": 0,
            "completed": 0,
            "total": 0,
            "updatedAt": int(time.time()),
        })
        call = await ingest_url_job.spawn.aio(payload)
        await job_progress.put.aio(f"call:{call.object_id}", progress_key)
        return response({"ok": True, "jobId": call.object_id}, 202)

    @api.post("/submit-audio")
    async def submit_audio(request: Request):
        if not authorized(request):
            return response({"ok": False, "error": "unauthorized"}, 401)
        content_type = request.headers.get("content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
        if content_type not in ALLOWED_AUDIO_UPLOAD_CONTENT_TYPES:
            return response({"ok": False, "error": "invalid-audio-content-type"}, 415)
        claimed_bytes = request.headers.get("x-aura-audio-bytes", "")
        if not claimed_bytes.isdigit() or int(claimed_bytes) <= 0:
            return response({"ok": False, "error": "invalid-audio-upload"}, 400)
        claimed_bytes = int(claimed_bytes)
        if claimed_bytes > MAX_AUDIO_UPLOAD_BYTES:
            return response({"ok": False, "error": "subtitle-audio-too-large"}, 413)
        content_length = request.headers.get("content-length", "")
        if content_length.isdigit():
            content_length = int(content_length)
            if content_length > MAX_AUDIO_UPLOAD_BYTES:
                return response({"ok": False, "error": "subtitle-audio-too-large"}, 413)
            if content_length != claimed_bytes:
                return response({"ok": False, "error": "audio-size-mismatch"}, 400)
        source_language = request.headers.get("x-aura-source-language", "ja").strip().lower()
        if source_language not in {"ja", "en"}:
            return response({"ok": False, "error": "invalid-source-language"}, 400)
        try:
            title = unquote(request.headers.get("x-aura-title", "")).strip()[:MAX_TITLE_LENGTH]
        except Exception:
            return response({"ok": False, "error": "invalid-title"}, 400)
        audio_source = re.sub(
            r"[^a-z0-9._:-]",
            "",
            request.headers.get("x-aura-audio-source", "browser-audio"),
            flags=re.IGNORECASE,
        )[:64]

        input_path, audio_path = audio_job_paths()
        progress_key = uuid.uuid4().hex
        total_bytes = 0
        try:
            with open(input_path, "wb") as handle:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    total_bytes += len(chunk)
                    if total_bytes > MAX_AUDIO_UPLOAD_BYTES:
                        raise OverflowError("subtitle-audio-too-large")
                    handle.write(chunk)
            if total_bytes == 0:
                remove_audio_job_files(input_path, audio_path)
                return response({"ok": False, "error": "invalid-audio-upload"}, 400)
            if total_bytes != claimed_bytes:
                remove_audio_job_files(input_path, audio_path)
                return response({"ok": False, "error": "audio-size-mismatch"}, 400)
            audio_job_volume.commit()
            await put_job_progress(progress_key, {
                "phase": "queued",
                "progress": 0,
                "completed": 0,
                "total": 0,
                "updatedAt": int(time.time()),
            })
            media_log(f"audio upload accepted source={audio_source or 'browser-audio'} bytes={total_bytes}")
            call = await ingest_uploaded_audio_job.spawn.aio({
                "inputPath": input_path,
                "audioPath": audio_path,
                "title": title,
                "sourceLanguage": source_language,
                "progressKey": progress_key,
            })
        except OverflowError:
            remove_audio_job_files(input_path, audio_path)
            return response({"ok": False, "error": "subtitle-audio-too-large"}, 413)
        except Exception:
            remove_audio_job_files(input_path, audio_path)
            raise
        await job_progress.put.aio(f"call:{call.object_id}", progress_key)
        return response({"ok": True, "jobId": call.object_id}, 202)

    @api.get("/result/{job_id}")
    async def result(job_id: str, request: Request):
        if not authorized(request):
            return response({"ok": False, "error": "unauthorized"}, 401)
        if not JOB_ID_RE.fullmatch(job_id):
            return response({"ok": False, "error": "invalid-job-id"}, 400)
        progress_key = await job_progress.get.aio(f"call:{job_id}", "")
        state = await job_progress.get.aio(progress_key, {
            "phase": "queued",
            "progress": 0,
            "completed": 0,
            "total": 0,
        })
        try:
            call = modal.FunctionCall.from_id(job_id)
            value = await call.get.aio(timeout=0)
        except TimeoutError:
            return response({"ok": True, "status": "running", **state}, 202)
        except Exception:
            if progress_key:
                await job_progress.pop.aio(progress_key, None)
            await job_progress.pop.aio(f"call:{job_id}", None)
            return response({"ok": False, "error": "job-failed"}, 500)
        if progress_key:
            await job_progress.pop.aio(progress_key, None)
        await job_progress.pop.aio(f"call:{job_id}", None)
        return response({"ok": True, "status": "completed", "result": value})

    @api.delete("/cancel/{job_id}")
    async def cancel(job_id: str, request: Request):
        if not authorized(request):
            return response({"ok": False, "error": "unauthorized"}, 401)
        if not JOB_ID_RE.fullmatch(job_id):
            return response({"ok": False, "error": "invalid-job-id"}, 400)
        progress_key = await job_progress.get.aio(f"call:{job_id}", "")
        terminal = False
        try:
            call = modal.FunctionCall.from_id(job_id)
            try:
                await call.get.aio(timeout=0)
            except TimeoutError:
                pass
            except Exception:
                # A previously cancelled or failed call is safe to cancel again.
                pass
            else:
                terminal = True
                return response({"ok": True, "status": "completed"})
            try:
                await call.cancel.aio()
            except Exception:
                return response({"ok": False, "error": "job-cancellation-failed"}, 500)
            terminal = True
            return response({"ok": True, "status": "cancelled"})
        finally:
            if terminal:
                if progress_key:
                    await job_progress.pop.aio(progress_key, None)
                await job_progress.pop.aio(f"call:{job_id}", None)

    return api
