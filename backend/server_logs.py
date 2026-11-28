import logging
import os
import re
import shutil
import time
from contextlib import contextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import Event, Thread

import zstandard


MIN_FREE_BYTES = 2 * 1024 ** 3
CHECK_INTERVAL = 60


def snapshot(path):
    return f"{path.name}.{time.time_ns()}.pending"


class LogFileHandler(RotatingFileHandler):
    def paths(self):
        current = Path(self.baseFilename)
        return [current, *(current.with_name(f"{current.name}.{i}") for i in range(1, self.backupCount + 1))]

    def detach(self):
        with self.lock:
            if self.stream is not None:
                self.stream.close()
                self.stream = None
            for path in self.paths():
                if path.is_file() and path.stat().st_size:
                    path.rename(path.with_name(snapshot(path)))


def archive_log(source):
    target = source.with_suffix(".zst")
    temporary = target.with_suffix(".zst.tmp")
    try:
        with source.open("rb") as log, temporary.open("wb") as archive:
            compressor = zstandard.ZstdCompressor(level=zstandard.MAX_COMPRESSION_LEVEL, write_checksum=True)
            compressor.copy_stream(log, archive, size=os.fstat(log.fileno()).st_size)
            archive.flush()
            os.fsync(archive.fileno())
        temporary.replace(target)
        source.unlink()
    finally:
        temporary.unlink(missing_ok=True)


class ServerLogs:
    def __init__(self, directory):
        self.directory = directory.resolve()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.low_space = False
        self.files = []
        self.server = self.create_logger("server", max_bytes=1024 * 1024, backups=3)
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        self.server.addHandler(console)
        self.camera = self.create_logger("camera", max_bytes=256 * 1024, backups=2)
        self.location = self.create_logger("location", max_bytes=256 * 1024, backups=2)

    def create_logger(self, name, *, max_bytes, backups):
        logger = logging.Logger(f"parkovka.{name}", level=logging.INFO)
        handler = LogFileHandler(
            self.directory / f"{name}.log", maxBytes=max_bytes, backupCount=backups, encoding="utf-8", delay=True,
        )
        formatter = logging.Formatter("%(asctime)sZ %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
        formatter.converter = time.gmtime
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        self.files.append(handler)
        return logger

    def move_device_logs(self, database):
        for device in ("camera", "location"):
            log = database.with_suffix(f".{device}.log")
            candidates = [log, log.with_name(f"{log.name}.1"), log.with_name(f"{log.name}.2")]
            for path in candidates:
                if path.is_symlink() or not path.is_file():
                    continue
                try:
                    destination = self.directory / path.name
                    if destination.exists():
                        destination = self.directory / snapshot(path)
                    shutil.move(path, destination)
                except OSError:
                    self.server.exception("Не удалось перенести журнал %s", path.name)

    def check_space(self, database_directory):
        try:
            free = min(shutil.disk_usage(path).free for path in {self.directory, database_directory})
        except OSError:
            self.server.exception("Не удалось проверить свободное место на сервере")
            return

        low_space = free < MIN_FREE_BYTES
        if low_space and not self.low_space:
            self.server.warning("На сервере заканчивается место: свободно %.2f ГиБ. Сжимаем журналы.", free / 1024 ** 3)
        self.low_space = low_space

    def compress_logs(self):
        for handler in self.files:
            try:
                handler.detach()
            except OSError:
                self.server.exception("Не удалось подготовить журнал %s к сжатию", Path(handler.baseFilename).name)
        active_paths = {path for handler in self.files for path in handler.paths()}
        for source in self.directory.glob("*.log*"):
            if source in active_paths or source.is_symlink() or not source.is_file():
                continue
            try:
                if re.search(r"\.log(?:\.\d+)?$", source.name):
                    source = source.rename(source.with_name(snapshot(source)))
                elif not source.name.endswith(".pending"):
                    continue
                archive_log(source)
            except (OSError, zstandard.ZstdError):
                self.server.exception("Не удалось сжать журнал %s", source.name)

    @contextmanager
    def monitor(self, database_directory):
        stopped = Event()

        def run():
            while not stopped.is_set():
                if self.low_space:
                    self.compress_logs()
                if stopped.wait(CHECK_INTERVAL):
                    break
                self.check_space(database_directory)

        self.check_space(database_directory)
        worker = Thread(target=run, name="log-storage-monitor", daemon=True)
        worker.start()
        try:
            yield
        finally:
            stopped.set()
            worker.join()
