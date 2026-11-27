"""Persistent detector results for saved photographs, independent of OCR text."""
import json
import math
import hashlib
from collections import OrderedDict
from threading import Lock

from plate_recognition import analyze

# Bump this when detector weights or coordinate preprocessing change.
BOX_CACHE_VERSION = "alpr26-b9162ec-letterbox640-conf025-v1"
_recent = OrderedDict()
_recent_lock = Lock()


def remember_photo_boxes(image, boxes):
    key = (BOX_CACHE_VERSION, hashlib.sha256(image).digest())
    with _recent_lock:
        _recent[key] = boxes
        _recent.move_to_end(key)
        if len(_recent) > 256:
            _recent.popitem(last=False)


def recent_photo_boxes(image):
    key = (BOX_CACHE_VERSION, hashlib.sha256(image).digest())
    with _recent_lock:
        result = _recent.get(key)
        if result is not None:
            _recent.move_to_end(key)
        return result


def cached_photo_boxes(connection, identifier, kind, image):
    photo_column, cache_column = (("photo", "photo_boxes") if kind == "overview"
                                  else ("detail_photo", "detail_photo_boxes"))
    row = connection.execute(
        f"SELECT {cache_column} FROM report_captures WHERE report_id = ? AND {photo_column} = ?",
        (identifier, image),
    ).fetchone()
    if row and row[0]:
        try:
            cached = json.loads(row[0])
            boxes = cached.get("boxes")
            if (cached.get("version") == BOX_CACHE_VERSION and isinstance(boxes, list) and len(boxes) <= 5
                    and all(isinstance(box, list) and len(box) == 4
                            and all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in box)
                            and box[0] < box[2] and box[1] < box[3] for box in boxes)):
                return boxes
        except (ValueError, TypeError, AttributeError):
            pass
    boxes = recent_photo_boxes(image)
    if boxes is None:
        boxes = analyze(image, recognize=False)["boxes"]
        remember_photo_boxes(image, boxes)
    # The photo may have been replaced while inference was in progress. Never
    # associate its coordinates with a different image.
    connection.execute(
        f"UPDATE report_captures SET {cache_column} = ? WHERE report_id = ? AND {photo_column} = ?",
        (json.dumps({"version": BOX_CACHE_VERSION, "boxes": boxes}, separators=(",", ":")), identifier, image),
    )
    return boxes
