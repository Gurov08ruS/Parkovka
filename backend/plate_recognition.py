"""CPU-only plate detection and OCR. Images are never sent to external services."""
import io
import logging
import os
import re
import threading
from pathlib import Path

from plates import LETTER_TRANSLATION, REGISTRATION_CODES

LOG = logging.getLogger(__name__)
MODEL_DIR = Path(os.environ.get("PARKOVKA_PLATE_MODEL_DIR", "/var/lib/parkovka/models"))
_lock = threading.Lock()
_models = None


class RecognitionUnavailable(Exception):
    pass


def models():
    global _models
    if _models is None:
        import onnxruntime as ort
        from fast_plate_ocr import LicensePlateRecognizer
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        detector = ort.InferenceSession(str(MODEL_DIR / "alpr_26n.onnx"), sess_options=options,
                                        providers=["CPUExecutionProvider"])
        ocr = LicensePlateRecognizer(onnx_model_path=MODEL_DIR / "cct_xs_v2_global.onnx",
                                     plate_config_path=MODEL_DIR / "cct_xs_v2_global_plate_config.yaml",
                                     sess_options=options, device="cpu")
        _models = detector, ocr
    return _models


def analyze(image_bytes):
    # Bound inference concurrency on small servers; report temporary overload instead of queueing images indefinitely.
    if not _lock.acquire(timeout=20):
        raise RecognitionUnavailable("Распознавание занято. Повторите попытку через несколько секунд.")
    try:
        return _analyze(image_bytes)
    except (ValueError, RecognitionUnavailable):
        raise
    except Exception:
        LOG.exception("Ошибка локального распознавания номера")
        raise RecognitionUnavailable("Распознавание номера временно недоступно. Попробуйте позже.") from None
    finally:
        _lock.release()


def _analyze(image_bytes):
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        image = Image.open(io.BytesIO(image_bytes))
        if image.width * image.height > 40_000_000:
            raise ValueError("Снимок слишком большой для проверки номера.")
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError("Не удалось прочитать снимок. Переснимите фото.") from None
    detector, ocr = models()
    width, height = image.size
    scale = min(640 / width, 640 / height)
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    resized = image.resize(size, Image.Resampling.BILINEAR)
    left, top = (640 - size[0]) // 2, (640 - size[1]) // 2
    canvas = Image.new("RGB", (640, 640), (114, 114, 114))
    canvas.paste(resized, (left, top))
    tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    predictions = detector.run(None, {detector.get_inputs()[0].name: tensor})[0][0].T
    predictions = predictions[predictions[:, 4] >= 0.25]
    # Adjacent candidates are duplicates, not separate cars.
    boxes = []
    for cx, cy, w, h, score in predictions[predictions[:, 4].argsort()[::-1]]:
        x1, y1, x2, y2 = cx-w/2, cy-h/2, cx+w/2, cy+h/2
        area = max(0, x2-x1) * max(0, y2-y1)
        if not area:
            continue
        if any((max(0, min(x2, b[2])-max(x1, b[0])) * max(0, min(y2, b[3])-max(y1, b[1]))) /
               (area + b[4] - max(0, min(x2, b[2])-max(x1, b[0])) * max(0, min(y2, b[3])-max(y1, b[1]))) > .45 for b in boxes):
            continue
        boxes.append((x1, y1, x2, y2, area))
        if len(boxes) >= 5:
            break
    if not boxes:
        return {"found": False, "multiple": False, "plate": None, "region": None}
    result = {"found": True, "multiple": len(boxes) > 1, "plate": None, "region": None}
    if len(boxes) != 1:
        return result
    x1, y1, x2, y2, _ = boxes[0]
    margin_x, margin_y = (x2-x1)*.05, (y2-y1)*.12
    crop = image.crop((max(0, int((x1-left-margin_x)/scale)), max(0, int((y1-top-margin_y)/scale)),
                       min(width, int((x2-left+margin_x)/scale)), min(height, int((y2-top+margin_y)/scale))))
    if crop.width < 5 or crop.height < 5:
        return result
    prediction = ocr.run(np.asarray(crop), return_confidence=True)[0]
    text = re.sub(r"[^A-Z0-9А-Я]", "", prediction.plate.upper()).translate(LETTER_TRANSLATION)
    match = re.fullmatch(r"([АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2})([0-9]{2,3})", text)
    if match and match[2] in REGISTRATION_CODES:
        result.update(plate=match[1], region=match[2])
    return result
