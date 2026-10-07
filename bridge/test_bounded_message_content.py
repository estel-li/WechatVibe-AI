"""Real cache-reader decoding keeps ordinary content and bounds expanded messages."""
import unittest
from unittest.mock import patch

import zstandard

import cache_source


class BoundedContentTests(unittest.TestCase):
    def test_compressed_text_preserves_unicode_and_line_breaks(self):
        text = "  合成消息\n第二行 😀  "
        for write_content_size in (True, False):
            compressed = zstandard.ZstdCompressor(write_content_size=write_content_size).compress(text.encode())
            self.assertEqual(cache_source.CacheOnlyWeChatDB._friendly_content(compressed, "文本"), text)

    def test_expansion_over_budget_and_corrupt_frames_become_placeholders(self):
        with patch.object(cache_source, "MAX_MESSAGE_BYTES", 64):
            for compressed in (
                    zstandard.ZstdCompressor().compress(b"x" * 128),
                    zstandard.ZstdCompressor(write_content_size=False).compress(b"x" * 128),
                    b"\x28\xb5\x2f\xfdinvalid-frame", b"x" * 65):
                self.assertEqual(cache_source.CacheOnlyWeChatDB._friendly_content(compressed, "文本"), "[文本]")

    def test_ordinary_image_envelopes_keep_upstream_decoder(self):
        raw = b'<msg><img md5="0123456789abcdef0123456789abcdef"/></msg>'
        self.assertEqual(cache_source.CacheOnlyWeChatDB._friendly_content(raw, "图片"),
                         cache_source.WeChatDB._friendly_content(raw, "图片"))


if __name__ == "__main__":
    unittest.main()
