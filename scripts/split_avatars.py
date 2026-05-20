from PIL import Image
import numpy as np
from collections import deque
import os

OUT  = r'D:\LUAN\0.WIP\20.MEETING-CANVAS\excalidraw\public\decorations\avatars'
SRCS = [
    r'D:\LUAN\0.WIP\20.MEETING-CANVAS\excalidraw\public\decorations\avatars\Gemini_Generated_Image_d0eh6ad0eh6ad0eh.png',
    r'D:\LUAN\0.WIP\20.MEETING-CANVAS\excalidraw\public\decorations\avatars\Gemini_Generated_Image_s00peis00peis00p.png',
]

for n in [36, 37]:
    p = os.path.join(OUT, f'{n:02d}.png')
    if os.path.exists(p):
        os.remove(p)
        print(f'Deleted {n:02d}.png')

existing = {int(f[:-4]) for f in os.listdir(OUT) if f.endswith('.png') and f[:-4].isdigit()}
next_num = max(existing) + 1
print(f'Starting at: {next_num:02d}')


def find_segments(is_sep, n, min_seg=80):
    segs = []
    in_c = False
    st = 0
    for i in range(n):
        if not is_sep[i] and not in_c:
            in_c = True
            st = i
        elif is_sep[i] and in_c:
            in_c = False
            if i - st >= min_seg:
                segs.append((st, i))
    if in_c and n - st >= min_seg:
        segs.append((st, n))
    return segs


def flood_fill_color(arr, color_mask):
    """BFS flood-fill from all 4 edges where color_mask is True."""
    H, W = arr.shape[:2]
    bg = np.zeros((H, W), dtype=bool)
    q = deque()
    for x in range(W):
        for y in [0, H - 1]:
            if color_mask[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(H):
        for x in [0, W - 1]:
            if color_mask[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and not bg[ny, nx] and color_mask[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))
    return bg


PAD = 20
for src in SRCS:
    name = os.path.basename(src)
    img = Image.open(src).convert('RGBA')
    arr = np.array(img, dtype=np.uint8)
    H, W = arr.shape[:2]
    rgb = arr[:, :, :3].astype(float)

    # Detect background color from corners
    corner_pixels = [arr[0,0,:3], arr[0,W-1,:3], arr[H-1,0,:3], arr[H-1,W-1,:3]]
    avg_corner = np.mean(corner_pixels, axis=0)
    print(f'\n{name}  {W}x{H}  corner avg RGB={avg_corner.astype(int)}')

    # Black background (near 0,0,0)
    is_bg_px = np.all(rgb < 20, axis=2)
    bg = flood_fill_color(arr, is_bg_px)

    black_row = np.mean(bg, axis=1) > 0.85
    black_col = np.mean(bg, axis=0) > 0.85
    row_segs = find_segments(black_row, H)
    col_segs = find_segments(black_col, W)
    print(f'  Grid: {len(col_segs)}c x {len(row_segs)}r = {len(col_segs)*len(row_segs)} cells')
    print(f'  Cols: {col_segs}')
    print(f'  Rows: {row_segs}')

    out_arr = arr.copy()
    out_arr[bg, 3] = 0
    masked_img = Image.fromarray(out_arr, 'RGBA')

    count = 0
    for ry1, ry2 in row_segs:
        for cx1, cx2 in col_segs:
            cell_alpha = out_arr[ry1:ry2, cx1:cx2, 3]
            ys, xs = np.where(cell_alpha > 10)
            if len(ys) == 0:
                continue
            y1 = max(0, ys.min() + ry1 - PAD)
            y2 = min(H, ys.max() + ry1 + PAD + 1)
            x1 = max(0, xs.min() + cx1 - PAD)
            x2 = min(W, xs.max() + cx1 + PAD + 1)
            crop = masked_img.crop((x1, y1, x2, y2))
            out_path = os.path.join(OUT, f'{next_num:02d}.png')
            crop.save(out_path, 'PNG', optimize=True)
            print(f'  {next_num:02d}.png  {x2-x1}x{y2-y1}')
            next_num += 1
            count += 1
    print(f'  Saved {count} avatars')

print(f'\nDone. Last: {next_num-1:02d}.png')
