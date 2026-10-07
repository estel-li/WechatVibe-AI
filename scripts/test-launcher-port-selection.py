"""Synthetic port-selection checks; never launches the bridge, GUI, or model."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("start-real-client.py")
SPEC = importlib.util.spec_from_file_location("port_selection_launcher", SCRIPT)
launcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = launcher
SPEC.loader.exec_module(launcher)


class PortSelectionTests(unittest.TestCase):
    def setUp(self):
        temporary_root = SCRIPT.parent.parent / ".local" / "release-v1.2.3" / "tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="port-selection-", dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = launcher.Config(self.root, Path(sys.executable), 47001)
        self.marker = self.config.runtime_dir / "selected-port.json"

    def pin(self):
        with (patch.object(launcher, "health", return_value="unavailable"),
              patch.object(launcher, "port_occupied", return_value=False),
              patch.object(launcher, "previous_live_bridge", return_value=None),
              patch.object(launcher, "port_bindable", side_effect=lambda port: port != self.config.port)):
            return launcher.selected_port(self.config, allow_fallback=True)

    def test_reserved_default_falls_back_and_cold_start_and_status_reuse_pin(self):
        chosen = self.pin()
        self.assertNotEqual(chosen, self.config.port)
        record = json.loads(self.marker.read_text(encoding="utf-8"))
        self.assertEqual(record, {"schema": 1, "instanceId": self.config.instance_id, "port": chosen})
        original = self.marker.read_bytes()
        with (patch.object(launcher, "health", return_value="unavailable"),
              patch.object(launcher, "port_occupied", return_value=False),
              patch.object(launcher, "previous_live_bridge", return_value=None),
              patch.object(launcher, "port_bindable", return_value=True) as bindable):
            self.assertEqual(launcher.selected_port(self.config, allow_fallback=True), chosen)
            bindable.assert_called_once_with(chosen)
        with (patch.object(launcher, "port_bindable", side_effect=AssertionError("read-only status bound a port")),
              patch.object(launcher, "health", side_effect=AssertionError("selection probed a read-only port"))):
            self.assertEqual(launcher.selected_port(self.config, allow_fallback=False), chosen)
        self.assertEqual(self.marker.read_bytes(), original)

    def test_explicit_port_bypasses_fallback_in_main(self):
        self.pin()
        original = self.marker.read_bytes()
        with (patch.object(launcher, "PROJECT_ROOT", self.root),
              patch.dict(os.environ, {"CHATUI_PORT": "48003"}),
              patch.object(launcher, "selected_port", side_effect=AssertionError("explicit port changed")),
              patch.object(launcher, "launch_mutex", side_effect=AssertionError("selection mutex entered")),
              patch.object(launcher, "run_command", return_value=0) as run):
            self.assertEqual(launcher.main(["--no-open"]), 0)
        self.assertEqual(run.call_args.args[1].port, 48003)
        self.assertEqual(self.marker.read_bytes(), original)

    def test_selected_port_marker_is_not_treated_as_owned_process_record(self):
        self.pin()
        with patch.object(launcher, "process_identity", side_effect=AssertionError("pin has no PID")):
            self.assertEqual(launcher.owned_bridge_records(self.config, include_dead=True), [])
            self.assertIsNone(launcher.previous_live_bridge(self.config))

    def test_foreign_or_unhealthy_live_service_never_causes_port_hopping(self):
        for health, occupied, live in (("wrong service", False, None),
                                       ("unavailable", True, None),
                                       ("unavailable", False, {"pid": 7, "log": "synthetic"})):
            with self.subTest(health=health, occupied=occupied, live=bool(live)):
                with (patch.object(launcher, "health", return_value=health),
                      patch.object(launcher, "port_occupied", return_value=occupied),
                      patch.object(launcher, "previous_live_bridge", return_value=live),
                      patch.object(launcher, "port_bindable", side_effect=AssertionError("live port bypassed"))):
                    self.assertEqual(launcher.selected_port(self.config, allow_fallback=True), self.config.port)
                self.assertFalse(self.marker.exists())

    def test_concurrent_main_uses_root_mutex_and_writes_only_one_pin(self):
        barrier = threading.Barrier(2)
        outcomes, errors, ports = [], [], []
        replace = os.replace
        def command(_args, config):
            ports.append(config.port)
            return 0
        def invoke():
            try:
                barrier.wait(timeout=3)
                outcomes.append(launcher.main(["--no-open"]))
            except Exception as error:
                errors.append(error)
        with (patch.object(launcher, "PROJECT_ROOT", self.root),
              patch.object(launcher, "default_port", return_value=self.config.port),
              patch.dict(os.environ, {"CHATUI_PORT": ""}),
              patch.object(launcher, "health", return_value="unavailable"),
              patch.object(launcher, "port_occupied", return_value=False),
              patch.object(launcher, "previous_live_bridge", return_value=None),
              patch.object(launcher, "port_bindable", side_effect=lambda port: port != self.config.port),
              patch.object(launcher.os, "replace", wraps=replace) as writes,
              patch.object(launcher, "run_command", side_effect=command)):
            threads = [threading.Thread(target=invoke) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(outcomes, [0, 0])
        self.assertEqual(len(set(ports)), 1)
        self.assertNotEqual(ports[0], self.config.port)
        self.assertEqual(writes.call_count, 1)
        self.assertEqual(json.loads(self.marker.read_text())["port"], ports[0])


if __name__ == "__main__":
    unittest.main()
