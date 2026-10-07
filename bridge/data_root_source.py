"""A manual discovery hint; it never selects an account or opens chat databases."""
from __future__ import annotations

import json
import os
import sys
import threading
import uuid
from pathlib import Path


CUSTOM_ROOT_ENV = "WECHATVIBE_DATA_ROOT"
_MISSING = object()
_CONFIG_LIMIT = 32_768


class DataRootError(ValueError):
    pass


class DataRootSource:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.config = self.root / ".local" / "real-client-runtime" / "wechat-data-root.json"
        self.lock = threading.RLock()

    def _check_config(self):
        if not self.config.resolve().is_relative_to(self.root):
            raise DataRootError("数据目录配置不可用")
        cursor = self.config
        while cursor != self.root:
            try:
                attributes = cursor.lstat()
            except FileNotFoundError:
                pass
            else:
                if cursor.is_symlink() or getattr(attributes, "st_file_attributes", 0) & 0x400:
                    raise DataRootError("数据目录配置不可用")
            cursor = cursor.parent

    def _stored_path(self):
        self._check_config()
        try:
            with self.config.open("rb") as stream:
                raw = stream.read(_CONFIG_LIMIT + 1)
        except FileNotFoundError:
            return _MISSING
        if len(raw) > _CONFIG_LIMIT:
            raise DataRootError("数据目录配置不可用")
        data = json.loads(raw.decode("utf-8"))
        if (not isinstance(data, dict) or set(data) != {"schema", "path"} or
                type(data["schema"]) is not int or data["schema"] != 1):
            raise DataRootError("数据目录配置不可用")
        value = data["path"]
        if value is not None:
            self._path(value)
        return value

    @staticmethod
    def _path(value):
        if (not isinstance(value, str) or not 1 <= len(value) <= 4096 or
                any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise DataRootError("请输入有效的目录路径")
        path = Path(value)
        if not path.is_absolute():
            raise DataRootError("请输入绝对路径")
        return path

    @staticmethod
    def _accounts(path):
        # Reuse the same shallow directory metadata discovery as automatic mode.
        # Passing roots prevents a settings read from scanning unrelated defaults.
        native_reader = str(Path(__file__).resolve().parents[1] / "native-reader")
        if native_reader not in sys.path:
            sys.path.insert(0, native_reader)
        from wr import discovery
        roots = [str(path), *(str(path / name) for name in discovery.DATA_ROOT_NAMES)]
        return len(discovery.discover_account_dirs(roots=roots))

    def _write(self, value):
        self._check_config()
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self._check_config()
        temporary = self.config.with_name(self.config.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump({"schema": 1, "path": value}, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.config)
        finally:
            temporary.unlink(missing_ok=True)

    def status(self):
        with self.lock:
            try:
                value = self._stored_path()
                if value is _MISSING:
                    value = os.environ.get(CUSTOM_ROOT_ENV) or None
                if value is None:
                    return {"state": "unset", "path": "", "exists": False, "accounts": 0}
                path = self._path(value)
                exists = path.is_dir()
                count = self._accounts(path) if exists else 0
                return {"state": "ready" if count else "missing", "path": str(path),
                        "exists": exists, "accounts": count}
            except (OSError, ValueError):
                return {"state": "invalid", "path": "", "exists": False, "accounts": 0}

    def select(self, value):
        with self.lock:
            path = self._path(value)
            if not path.is_dir():
                raise DataRootError("目录不存在，请选择已存在的目录")
            path = path.resolve()
            if path.name.lower() == "db_storage":
                path = path.parent
            if not self._accounts(path):
                raise DataRootError("目录内未发现微信数据，请选择 xwechat_files 或账号目录")
            self._write(str(path))
            os.environ[CUSTOM_ROOT_ENV] = str(path)
            return self.status()

    def clear(self):
        with self.lock:
            self._write(None)
            os.environ.pop(CUSTOM_ROOT_ENV, None)
            return self.status()

    def apply(self):
        """Apply before workers start; an absent setting preserves an inherited hint."""
        with self.lock:
            try:
                value = self._stored_path()
            except (OSError, ValueError):
                return
            if value is _MISSING:
                return
            if value is None:
                os.environ.pop(CUSTOM_ROOT_ENV, None)
            else:
                os.environ[CUSTOM_ROOT_ENV] = value
