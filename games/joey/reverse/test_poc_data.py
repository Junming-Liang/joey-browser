import pathlib
import unittest
from poc_data import catalog, deck, legacy_to_internal, lzss


class ResourcesTest(unittest.TestCase):
    def test_overlapping_reference(self):
        self.assertEqual(lzss(bytes.fromhex("07414243eef3"), 9), b"ABCABCABC")
        for malformed in (b"", b"\x01", b"\0\xee"):
            with self.assertRaises(ValueError):
                lzss(malformed, 9)
        with self.assertRaises(ValueError):
            lzss(bytes.fromhex("07414243eef3"), 8)

    def test_real_original_data(self):
        root = pathlib.Path(__file__).resolve().parents[3] / ".bridge/joey-web/reverse/input/resources"
        if not root.exists():
            self.skipTest("Original resources are local, not distributed with source")
        cards = catalog(root)
        self.assertEqual(sum(bool(c["pack"]) for c in cards), 771)
        axe = next(c for c in cards if c["nameEn"] == "Axe Raider")
        self.assertEqual((axe["code"], axe["attack"], axe["defense"], axe["level"]), (48305365, 1700, 1150, 4))
        inverse = (root / "bin#/card_intid.bin").read_bytes()
        self.assertEqual(legacy_to_internal(4000, inverse), 0)
        for path in root.rglob("*.ydc"):
            decoded = deck(path.read_bytes(), inverse, cards)
            self.assertTrue(40 <= len(decoded["main"]) <= 45)
            if path.stem.lower() == "cpu_029":
                self.assertEqual(len(decoded["side"]), 6)


if __name__ == "__main__":
    unittest.main()
