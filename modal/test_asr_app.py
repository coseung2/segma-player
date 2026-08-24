import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock


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


if __name__ == "__main__":
    unittest.main()
