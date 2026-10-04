"""Scales dolphin-mark.png up with nearest-neighbour onto a 1024x1024 transparent canvas for `tauri icon`."""
from PIL import Image

SCALE = 28  # 34x23 -> 952x644, the largest whole number that leaves a margin

mark = Image.open("src/assets/dolphin-mark.png").convert("RGBA")
big = mark.resize((mark.width * SCALE, mark.height * SCALE), Image.NEAREST)
canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
canvas.paste(big, ((1024 - big.width) // 2, (1024 - big.height) // 2))
canvas.save("src-tauri/app-icon.png")
