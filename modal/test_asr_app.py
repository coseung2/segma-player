import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

from fastapi.testclient import TestClient


MODULE_PATH = pathlib.Path(__file__).with_name("asr_app.py")
SPEC = importlib.util.spec_from_file_location("aura_asr_app_test_target", MODULE_PATH)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


class UrlIngestSecurityTests(unittest.TestCase):
    def test_public_resolution_is_pinned_and_private_answers_fail_closed(self):
        public = [(None, None, None, None, ("1.1.1.1", 443))]
        private = [(None, None, None, None, ("127.0.0.1", 443))]
        with mock.patch.object(ASR.socket, "getaddrinfo", return_value=public):
            self.assertEqual(
                ASR.pinned_public_resolution("https://media.example/video"),
                ["--resolve", "media.example:443:1.1.1.1"],
            )
        with mock.patch.object(ASR.socket, "getaddrinfo", return_value=private):
            with self.assertRaisesRegex(ValueError, "invalid-media-host"):
                ASR.pinned_public_resolution("https://media.example/video")

    def test_curl_disables_proxies_and_redirects_and_uses_the_pinned_address(self):
        captured = []
        with mock.patch.object(
            ASR,
            "pinned_public_resolution",
            return_value=["--resolve", "media.example:443:1.1.1.1"],
        ), mock.patch.object(
            ASR.subprocess,
            "run",
            side_effect=lambda command, **kwargs: captured.append((command, kwargs)) or mock.Mock(),
        ):
            ASR.curl_download(
                "https://media.example/video.mp4",
                "output.bin",
                "https://page.example/watch/1",
            )
        command = captured[0][0]
        self.assertIn("--noproxy", command)
        self.assertEqual(command[command.index("--noproxy") + 1], "*")
        self.assertIn("--resolve", command)
        self.assertNotIn("--location", command)

    def test_remote_audio_is_materialized_before_ffmpeg(self):
        captured = []
        with tempfile.TemporaryDirectory() as workdir, mock.patch.object(
            ASR,
            "browser_fingerprint_media",
            return_value=(workdir, str(pathlib.Path(workdir) / "input.bin")),
        ), mock.patch.object(
            ASR.subprocess,
            "run",
            side_effect=lambda command, **kwargs: captured.append((command, kwargs)) or mock.Mock(),
        ), mock.patch.object(ASR, "set_job_progress"):
            ASR.extract_remote_audio(
                {
                    "mediaUrl": "https://media.example/video.mp4",
                    "sourceUrl": "https://page.example/watch/1",
                    "progressKey": "progress-1",
                },
                str(pathlib.Path(workdir) / "audio.wav"),
            )
        command = captured[0][0]
        input_value = command[command.index("-i") + 1]
        self.assertFalse(input_value.startswith("http"))
        self.assertNotIn("-protocol_whitelist", command)


class AudioUploadContractTests(unittest.TestCase):
    def setUp(self):
        self.token_patch = mock.patch.dict(ASR.os.environ, {"MODAL_ASR_TOKEN": "test-token"})
        self.token_patch.start()
        self.client = TestClient(ASR.web.local())

    def tearDown(self):
        self.client.close()
        self.token_patch.stop()

    def test_content_length_and_80_mib_boundary_match_worker_contract(self):
        maximum = 80 * 1024 * 1024
        accepted = {
            "content-type": "audio/mp4",
            "x-aura-audio-bytes": str(maximum),
            "content-length": str(maximum),
        }
        self.assertIsNone(ASR.audio_upload_header_error(accepted))
        self.assertEqual(
            ASR.audio_upload_header_error({
                **accepted,
                "content-length": str(maximum - 1),
            }),
            ("audio-size-mismatch", 400),
        )
        self.assertEqual(
            ASR.audio_upload_header_error({
                **accepted,
                "x-aura-audio-bytes": str(maximum + 1),
                "content-length": str(maximum + 1),
            }),
            ("subtitle-audio-too-large", 413),
        )

    def test_submit_audio_http_boundary_rejects_mismatch_before_body_or_spawn(self):
        with mock.patch.object(ASR, "audio_job_paths") as paths:
            response = self.client.post(
                "/submit-audio",
                content=b"four",
                headers={
                    "authorization": "Bearer test-token",
                    "content-type": "audio/mp4",
                    "content-length": "4",
                    "x-aura-audio-bytes": "5",
                },
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"ok": False, "error": "audio-size-mismatch"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        paths.assert_not_called()

    def test_submit_audio_http_boundary_rejects_oversized_headers_before_upload(self):
        oversized = 80 * 1024 * 1024 + 1
        with mock.patch.object(ASR, "audio_job_paths") as paths:
            response = self.client.post(
                "/submit-audio",
                content=b"x",
                headers={
                    "authorization": "Bearer test-token",
                    "content-type": "audio/mp4",
                    "content-length": str(oversized),
                    "x-aura-audio-bytes": str(oversized),
                },
            )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json(), {"ok": False, "error": "subtitle-audio-too-large"})
        paths.assert_not_called()

    def test_normalization_caps_audio_at_exactly_60_minutes(self):
        command = ASR.audio_extract_command("input.m4a", "output.wav")
        duration_index = command.index("-t")
        self.assertEqual(command[duration_index + 1], str(60 * 60))


class SpeakerDiarizationTests(unittest.TestCase):
    def test_chunks_use_largest_overlap_and_stable_korean_labels(self):
        chunks = [
            {"timestamp": [0.0, 2.0], "text": "first"},
            {"timestamp": [2.0, 4.0], "text": "second"},
            {"timestamp": [4.0, 6.0], "text": "third"},
        ]
        turns = [
            {"start": 0.0, "end": 2.2, "speaker": "SPEAKER_01"},
            {"start": 2.2, "end": 4.2, "speaker": "SPEAKER_00"},
            {"start": 4.2, "end": 6.0, "speaker": "SPEAKER_01"},
        ]
        assigned, speakers = ASR.assign_speakers(chunks, turns)
        self.assertEqual([chunk["speaker"] for chunk in assigned], ["화자 1", "화자 2", "화자 1"])
        self.assertEqual(speakers, ["화자 1", "화자 2"])

    def test_vtt_emits_standard_voice_cues(self):
        vtt = ASR.chunks_to_vtt([
            {"timestamp": [1.0, 2.5], "text": "안녕하세요", "speaker": "화자 1"},
        ])
        self.assertIn("<v 화자 1>안녕하세요", vtt)


if __name__ == "__main__":
    unittest.main()
