"""The 16x16 version of the front-facing dolphin, for favicons and tiny icons."""
from PIL import Image

COL = {"#": (74, 28, 4), "O": (255, 138, 26), "o": (232, 106, 8), "h": (255, 184, 108), "w": (255, 244, 228),
       "e": (36, 14, 4), "W": (255, 255, 255), "p": (255, 128, 108), "m": (110, 40, 6)}
R = [
    "." * 16,
    "." * 9 + "#" + "." * 6,
    "." * 8 + "#o#" + "." * 5,
    "." * 4 + "#" * 8 + "." * 4,
    "." * 3 + "#" + "hhOOOOOo" + "#" + "." * 3,
    "." * 2 + "#" + "hOOOOOOOOo" + "#" + "." * 2,
    "." * 2 + "#" + "OOOOOOOOOo" + "#" + "." * 2,
    "." + "#" + "OOWeOOOOWeOo" + "#" + ".",
    "." + "#" + "OOeeOOOOeeOo" + "#" + ".",
    "." + "#" + "OpOmOhhOmOpo" + "#" + ".",
    "." + "#" + "OOOOmmmmOOOo" + "#" + ".",
    "#O#" + "OOOwwwwOOo" + "#" + "O#",
    "." + "##" + "#" + "Owwwwwwo" + "#" + "##" + ".",
    "." * 4 + "#" + "owwwwo" + "#" + "." * 4,
    "." * 5 + "#" * 6 + "." * 5,
    "." * 16,
]
R = [r[:16].ljust(16, ".") for r in R]
img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
for y, r in enumerate(R):
    for x, c in enumerate(r):
        if c != ".": img.putpixel((x, y), COL[c] + (255,))
img.save("design/dolphin-front-16.png")
big = Image.new("RGBA", (16 * 16 + 120, 16 * 16 + 20), (14, 14, 16, 255))
big.alpha_composite(img.resize((256, 256), Image.NEAREST), (10, 10))
big.alpha_composite(img, (290, 20))
big.alpha_composite(img.resize((32, 32), Image.NEAREST), (290, 50))
big.save("design/_front16-check.png")
for r in R: print(r)
