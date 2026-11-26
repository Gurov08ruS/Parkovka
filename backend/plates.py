import json
import re
from pathlib import Path


LETTER_TRANSLATION = str.maketrans("ABEKMHOPCTYX", "АВЕКМНОРСТУХ")
PLATE_CHARACTERS = re.compile(r"[АВЕКМНОРСТУХ0-9 -]*")
PLATE_WITH_REGION = re.compile(r"([АВЕКМНОРСТУХ] *[0-9]{3} *[АВЕКМНОРСТУХ] *[АВЕКМНОРСТУХ])[ -]*([0-9]{2,3})")
REGIONS = json.loads((Path(__file__).parent.parent / "frontend" / "plate-regions.json").read_text(encoding="utf-8"))
REGISTRATION_CODES = frozenset(code for primary, region in REGIONS.items() for code in (primary, *region.get("codes", ())))


def normalize_region(name):
    return re.sub(r"[^а-яa-z0-9]+", " ", name.casefold().replace("ё", "е")).strip()


LOCATION_CODES = {
    normalize_region(name): code
    for code, region in REGIONS.items() if region.get("flag", True)
    for name in [region["name"], *region.get("aliases", [])]
}
