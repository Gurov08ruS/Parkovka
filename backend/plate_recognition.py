"""CPU-only plate detection and OCR. Images are never sent to external services."""
import io
import math
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
_ppocr = None
_backup_ocr = None


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


def backup_model():
    global _backup_ocr
    if _backup_ocr is None:
        import onnxruntime as ort
        from fast_plate_ocr import LicensePlateRecognizer
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        _backup_ocr = LicensePlateRecognizer(onnx_model_path=MODEL_DIR / "cct_s_v2_global.onnx",
                                             plate_config_path=MODEL_DIR / "cct_s_v2_global_plate_config.yaml",
                                             sess_options=options, device="cpu")
    return _backup_ocr


def analyze(image_bytes, *, recognize=True):
    # Bound inference concurrency on small servers; report temporary overload instead of queueing images indefinitely.
    if not _lock.acquire(timeout=20):
        raise RecognitionUnavailable("Распознавание занято. Повторите попытку через несколько секунд.")
    try:
        return _analyze(image_bytes, recognize=recognize)
    except (ValueError, RecognitionUnavailable):
        raise
    except Exception:
        LOG.exception("Ошибка локального распознавания номера")
        raise RecognitionUnavailable("Распознавание номера временно недоступно. Попробуйте позже.") from None
    finally:
        _lock.release()


def _analyze(image_bytes, *, recognize=True):
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
    # Coordinates are normalized to the displayed, orientation-corrected photo.
    rectangles = []
    for x1, y1, x2, y2, _ in boxes:
        x1, x2 = max(0, (x1-left)/scale), min(width, (x2-left)/scale)
        y1, y2 = max(0, (y1-top)/scale), min(height, (y2-top)/scale)
        if x2 > x1 and y2 > y1:
            rectangles.append([round(float(x1/width), 6), round(float(y1/height), 6),
                               round(float(x2/width), 6), round(float(y2/height), 6)])
    result = {"found": bool(rectangles), "multiple": len(rectangles) > 1,
              "plate": None, "region": None, "boxes": rectangles}
    if len(rectangles) != 1 or not recognize:
        return result
    x1, y1, x2, y2 = rectangles[0]
    tight_crop = image.crop((max(0, int(x1*width)), max(0, int(y1*height)),
                             min(width, int(x2*width)), min(height, int(y2*height))))
    margin_x, margin_y = (x2-x1)*width*.05, (y2-y1)*height*.12
    padded_crop = image.crop((max(0, int(x1*width-margin_x)), max(0, int(y1*height-margin_y)),
                              min(width, int(x2*width+margin_x)), min(height, int(y2*height+margin_y))))
    if tight_crop.width < 5 or tight_crop.height < 5:
        return result
    # Plate-specific OCR is sensitive to the space around the plate. Try the
    # detector's exact crop first, then a padded crop for imperfect detections.
    candidate = (None, None)
    for crop in (tight_crop, padded_crop):
        prediction = ocr.run(np.asarray(crop), return_confidence=True)[0]
        plate, region = parse_plate(prediction.plate)
        if plate and not candidate[0]:
            candidate = (plate, region)
        if plate and region:
            candidate = (plate, region)
            break
    # On a Russian plate sample the smaller specialist model was more accurate;
    # use the new model as a fallback when it cannot read the whole plate.
    if not candidate[1]:
        backup = backup_model().run(np.asarray(tight_crop), return_confidence=True)[0]
        backup_plate, backup_region = parse_plate(backup.plate)
        if candidate[0] and backup_plate and backup_plate != candidate[0]:
            return result
        if not candidate[0] or (backup_plate == candidate[0] and backup_region):
            candidate = (backup_plate, backup_region)
    if not candidate[1]:
        for crop in (tight_crop, padded_crop):
            plate, region = parse_plate(read_cyrillic(crop))
            if candidate[0] and plate and plate != candidate[0]:
                continue
            if plate and (not candidate[0] or region):
                candidate = (plate, region)
            if candidate[0] and candidate[1]:
                break
    result.update(plate=candidate[0], region=candidate[1])
    return result


def parse_plate(text):
    text = re.sub(r"[^A-Z0-9А-Я]", "", text.upper()).translate(LETTER_TRANSLATION)
    # Russian private-car plates have fixed letter and digit positions. OCR
    # frequently confuses О and 0; correct only this visually identical pair.
    if len(text) >= 6:
        chars = list(text)
        for index in (0, 4, 5):
            if chars[index] == "0":
                chars[index] = "О"
        for index in (1, 2, 3, *range(6, min(len(chars), 9))):
            if chars[index] == "О":
                chars[index] = "0"
        text = "".join(chars)
    match = re.match(r"([АВЕКМНОРСТУХ][0-9]{3}[АВЕКМНОРСТУХ]{2})([0-9]{2,3})?", text)
    if not match:
        return None, None
    region = match[2] if match[2] in REGISTRATION_CODES else None
    return match[1], region


def read_cyrillic(crop):
    global _ppocr
    import cv2
    import numpy as np
    import onnxruntime as ort
    if _ppocr is None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.log_severity_level = 3
        session = ort.InferenceSession(str(MODEL_DIR / "ppocr6_cyrillic.onnx"), sess_options=options,
                                       providers=["CPUExecutionProvider"])
        characters = [""] + session.get_modelmeta().custom_metadata_map["character"].splitlines() + [" "]
        _ppocr = session, characters
    session, characters = _ppocr
    image = np.asarray(crop)[:, :, ::-1]  # PaddleOCR uses BGR.
    height, width = image.shape[:2]
    resized_width = min(640, max(1, math.ceil(48 * width / height)))
    resized = cv2.resize(image, (resized_width, 48)).astype(np.float32) / 127.5 - 1.0
    tensor = np.zeros((48, 640, 3), dtype=np.float32)
    tensor[:, :resized_width] = resized
    scores = session.run(None, {session.get_inputs()[0].name: tensor.transpose(2, 0, 1)[None]})[0][0]
    indices = scores.argmax(axis=1)
    return "".join(characters[index] for i, index in enumerate(indices)
                   if index and (not i or index != indices[i - 1]))
