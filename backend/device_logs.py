import json
import re


STAGES = {"context", "max_permissions", "stream", "preview", "capture", "switch", "flash"}
PLATFORMS = {"android", "ios", "desktop", "web", "browser", "unknown"}
MAX_BRIDGE_CODE = re.compile(r"(?:client|server)(?:\.[a-z_][a-z_0-9]*){1,5}")
MAX_PERMISSION_CODES = {"app_permission_denied", "system_permission_denied", "TypeError", "Error", "NotSupportedError", "AbortError"}
CODES = {
    "insecure_context", "api_unavailable", "policy_blocked", "document_hidden", "track_ended", "preview_timeout",
    "video_error", "frame_unavailable", "invalid_jpeg", "invalid_image", "photo_too_large",
    "AbortError", "InvalidStateError", "NotAllowedError", "NotFoundError", "NotReadableError",
    "NotSupportedError", "OverconstrainedError", "SecurityError", "TypeError", "UnknownError",
    "MaxAppPermissionDenied", "MaxSystemPermissionDenied", "MaxPermissionError", "MaxBridgeUnavailable",
    "MaxPermissionTimeout", "MaxSettingsError", "CameraStreamTimeout",
}
LOCATION_CODES = {
    "context": {"insecure_context", "api_unavailable"},
    "position": {"permission_denied", "position_unavailable", "timeout", "invalid_coordinates", "unknown_error"},
    "address": {"lookup_failed", "address_not_found"},
}


def log_camera_error(logger, data):
    stage, code, photo = data.get("stage"), data.get("code"), data.get("photo")
    if (not isinstance(stage, str) or stage not in STAGES
            or not isinstance(code, str) or code not in CODES
            or photo not in ("overview", "detail")):
        raise ValueError("Некорректная диагностика камеры.")
    event = {"stage": stage, "code": code, "photo": photo}
    if stage == "max_permissions":
        bridge_code = data.get("bridge_code")
        if (isinstance(bridge_code, str) and len(bridge_code) <= 120
                and (bridge_code in MAX_PERMISSION_CODES or MAX_BRIDGE_CODE.fullmatch(bridge_code))):
            event["bridge_code"] = bridge_code
        if data.get("bridge_step") in ("init", "request"):
            event["bridge_step"] = data["bridge_step"]
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
    platform = data.get("platform")
    if isinstance(platform, str) and platform in PLATFORMS:
        event["platform"] = platform
    logger.warning(json.dumps(event, separators=(",", ":")))
