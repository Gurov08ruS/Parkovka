import json
import logging
from logging.handlers import RotatingFileHandler
from time import gmtime


STAGES = {"context", "max_permissions", "stream", "preview", "capture", "switch", "flash"}
CODES = {
    "insecure_context", "api_unavailable", "document_hidden", "track_ended", "preview_timeout",
    "video_error", "frame_unavailable", "invalid_jpeg", "photo_too_large",
    "AbortError", "InvalidStateError", "NotAllowedError", "NotFoundError", "NotReadableError",
    "NotSupportedError", "OverconstrainedError", "SecurityError", "TypeError", "UnknownError",
    "MaxAppPermissionDenied", "MaxSystemPermissionDenied", "MaxPermissionError",
}
LOCATION_CODES = {
    "context": {"insecure_context", "api_unavailable"},
    "position": {"permission_denied", "position_unavailable", "timeout", "invalid_coordinates", "unknown_error"},
    "address": {"lookup_failed"},
}


def create_device_logger(path):
    logger = logging.Logger(f"stukach.{path.stem}")
    handler = RotatingFileHandler(path, maxBytes=256 * 1024, backupCount=2, encoding="utf-8", delay=True)
    formatter = logging.Formatter('%(asctime)sZ %(message)s', datefmt="%Y-%m-%dT%H:%M:%S")
    formatter.converter = gmtime
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def log_camera_error(logger, data):
    stage, code, photo = data.get("stage"), data.get("code"), data.get("photo")
    if (not isinstance(stage, str) or stage not in STAGES
            or not isinstance(code, str) or code not in CODES
            or photo not in ("overview", "detail")):
        raise ValueError("Некорректная диагностика камеры.")
    event = {"stage": stage, "code": code, "photo": photo}
    write_event(logger, event, data)


def log_location_error(logger, data):
    stage, code = data.get("stage"), data.get("code")
    if not isinstance(stage, str) or not isinstance(code, str) or code not in LOCATION_CODES.get(stage, ()):
        raise ValueError("Некорректная диагностика геолокации.")
    write_event(logger, {"stage": stage, "code": code}, data)


def write_event(logger, event, data):
    for field in ("secure_context", "in_max"):
        if type(data.get(field)) is not bool:
            raise ValueError("Некорректные данные диагностики.")
        event[field] = data[field]
    logger.warning(json.dumps(event, separators=(",", ":")))
