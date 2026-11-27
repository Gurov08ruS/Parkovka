"""Regression tests for OCR crop selection; no user photographs are stored here."""
import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import plate_recognition


class Detector:
    def get_inputs(self):
        return [SimpleNamespace(name="images")]

    def run(self, *_args):
        return [np.array([[[320], [320], [200], [60], [.9]]], dtype=np.float32)]


class CropSensitiveOCR:
    def __init__(self):
        self.sizes = []

    def run(self, image, **_kwargs):
        self.sizes.append(image.shape[:2])
        return [SimpleNamespace(plate="A123BC777" if image.shape[:2] == (60, 200) else "")]


class FixedOCR:
    def __init__(self, plate):
        self.plate = plate

    def run(self, _image, **_kwargs):
        return [SimpleNamespace(plate=self.plate)]


class PlateCropTest(unittest.TestCase):
    def test_tight_crop_is_read_before_background_is_added(self):
        photo = io.BytesIO()
        Image.new("RGB", (640, 640), "white").save(photo, format="PNG")
        ocr = CropSensitiveOCR()
        with patch.object(plate_recognition, "models", return_value=(Detector(), ocr)), \
             patch.object(plate_recognition, "backup_model", return_value=CropSensitiveOCR()), \
             patch.object(plate_recognition, "read_cyrillic", side_effect=AssertionError("unexpected fallback")):
            result = plate_recognition.analyze(photo.getvalue())
        self.assertEqual((result["plate"], result["region"]), ("А123ВС", "777"))
        self.assertEqual(ocr.sizes, [(60, 200)])
        self.assertEqual(len(result["boxes"]), 1)

    def test_position_specific_o_zero_correction(self):
        self.assertEqual(plate_recognition.parse_plate("A7650H777"), ("А765ОН", "777"))
        self.assertEqual(plate_recognition.parse_plate("AO65OH777"), ("А065ОН", "777"))

    def test_fallback_recognizes_when_first_model_cannot(self):
        photo = io.BytesIO()
        Image.new("RGB", (640, 640), "white").save(photo, format="PNG")
        with patch.object(plate_recognition, "models", return_value=(Detector(), FixedOCR(""))), \
             patch.object(plate_recognition, "backup_model", return_value=FixedOCR("A7650H777")), \
             patch.object(plate_recognition, "read_cyrillic", side_effect=AssertionError("unexpected fallback")):
            result = plate_recognition.analyze(photo.getvalue())
        self.assertEqual((result["plate"], result["region"]), ("А765ОН", "777"))


if __name__ == "__main__":
    unittest.main()
