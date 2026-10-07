"""Failed account-clear preparation must leave the untouched bridge available."""
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend_service import Backend
from model_source import ModelSourceStore


class LifecycleReliabilityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        source = SimpleNamespace(lock=threading.RLock(), identity=lambda: ("synthetic-account", root))
        analyzer = SimpleNamespace(model={"state": "ready"})
        self.backend = Backend(source, analyzer, model_source_store=ModelSourceStore(root / "models.json", root=root))
        self.addCleanup(self.backend.shutdown)

    def test_failed_assistant_stop_does_not_leave_bridge_permanently_closing(self):
        with patch.object(self.backend, "_close_assistant", side_effect=RuntimeError("synthetic stop failure")), \
                patch.object(self.backend, "_stop_workers") as stop:
            with self.assertRaisesRegex(RuntimeError, "synthetic stop failure"):
                self.backend.pause_for_account_clear("synthetic-account")
        stop.assert_not_called()
        self.assertFalse(self.backend.closing)
        self.assertFalse(self.backend.account_clear_paused)
        self.assertTrue(self.backend.worker_thread.is_alive())
        with self.backend.request_lease():
            self.assertEqual(self.backend.active_requests, 1)
        self.assertEqual(self.backend.active_requests, 0)

    def test_failed_api_drain_does_not_stop_workers_or_reject_following_requests(self):
        with patch.object(self.backend.api_tasks, "wait_for_idle", return_value=False), \
                patch.object(self.backend, "_stop_workers") as stop:
            with self.assertRaisesRegex(RuntimeError, "API insight requests did not finish"):
                self.backend.pause_for_account_clear("synthetic-account")
        stop.assert_not_called()
        self.assertFalse(self.backend.closing)
        self.assertTrue(self.backend.worker_thread.is_alive())
        with self.backend.request_lease():
            pass


if __name__ == "__main__":
    unittest.main()
