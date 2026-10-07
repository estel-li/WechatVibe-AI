"""Account-scoped result metadata; all fixtures are synthetic."""
import unittest

from ai_assistant import _public_usage
import test_ai_assistant as fixtures


class MetadataAnalyzer(fixtures.Analyzer):
    usage = None

    def assistant_generate(self, *args, **kwargs):
        result = super().assistant_generate(*args, **kwargs)
        result["usage"] = self.usage
        return result


class AssistantUsageTests(unittest.TestCase):
    setUp = fixtures.AssistantTests.setUp
    tearDown = fixtures.AssistantTests.tearDown
    configure = fixtures.AssistantTests.configure
    start = fixtures.AssistantTests.start
    wait = fixtures.AssistantTests.wait

    def test_job_exposes_only_validated_numeric_usage_and_original_model_metadata(self):
        self.configure()
        self.source.add(3)
        analyzer = MetadataAnalyzer()
        analyzer.usage = {"inputTokens": 1234, "outputTokens": 56,
                          "apiKey": "synthetic-secret", "raw": "synthetic-private-content"}
        self.next_analyzer = analyzer
        result = self.wait(self.start())
        self.assertEqual(result["usage"], {"inputTokens": 1234, "outputTokens": 56})
        self.assertEqual(result["model"], "deepseek-flash")
        self.assertEqual(result["contextTokens"], 1000000)
        self.assertGreaterEqual(result["finishedAt"], result["startedAt"])
        self.assertNotIn("synthetic-secret", str(result))
        self.assertNotIn("synthetic-private-content", str(result))

    def test_missing_or_invalid_usage_is_omitted_rather_than_inventing_a_zero(self):
        self.configure()
        self.source.add(1)
        analyzer = MetadataAnalyzer()
        analyzer.usage = {"inputTokens": True, "outputTokens": -5, "raw": "synthetic-secret"}
        self.next_analyzer = analyzer
        result = self.wait(self.start())
        self.assertNotIn("usage", result)


class UsageValidationTests(unittest.TestCase):
    def test_usage_count_bounds_and_partial_reports(self):
        for value in (None, "123", [], {}, {"inputTokens": float("nan")},
                      {"inputTokens": float("inf")}, {"outputTokens": 1.2},
                      {"inputTokens": 2 ** 53}):
            with self.subTest(value=value):
                self.assertIsNone(_public_usage(value))
        self.assertEqual(_public_usage({"inputTokens": 0}), {"inputTokens": 0})
        self.assertEqual(_public_usage({"inputTokens": 12, "outputTokens": "private-secret"}),
                         {"inputTokens": 12})


if __name__ == "__main__":
    unittest.main()
