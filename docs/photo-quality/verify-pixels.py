"""Independent PNG decoding; requires Pillow. Usage: python verify-pixels.py FIXTURE_DIR"""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, __version__ as pillow_version

directory = Path(sys.argv[1])
fixtures = json.loads((directory / "fixtures.json").read_text())
results = []
for case in fixtures["cases"]:
    paths = [directory / f"{case['name']}-{stage}.png" for stage in ["before", "after"]]
    decoded = []
    metadata = []
    for path in paths:
        with Image.open(path) as image:
            assert image.size == (case["width"], case["height"]), path
            decoded.append([list(pixel) for pixel in image.convert("RGBA").get_flattened_data()])
            metadata.append(sorted(image.info))
    assert decoded[0] == decoded[1] == case["expected"], case["name"]
    assert "Author" in metadata[0] and "Author" not in metadata[1], case["name"]
    results.append({
        **case,
        "decodedPixels": decoded[1],
        "sourceMatchesOutputAndExpected": True,
        "beforeMetadataKeys": metadata[0],
        "afterMetadataKeys": metadata[1],
        "sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
    })
print(json.dumps({"decoder": "Pillow", "version": pillow_version, "cases": results}, indent=2))
