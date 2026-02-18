#!/usr/bin/env python3
"""analyze_dxf.py v8.3 — Batch render + section detection (no merge)"""
import sys, json, os, time

def log(msg):
    print(msg, file=sys.stderr)

def analyze(dxf_path, output_dir):
    import ezdxf
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None  # Allow large renders (we generate these ourselves)

    start = time.time()
    os.makedirs(output_dir, exist_ok=True)

    log(f"Loading {os.path.basename(dxf_path)}...")
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    load_time = time.time() - start
    log(f"Loaded in {load_time:.1f}s")

    # ---- Count entities to detect if flattened ----
    counts = {}
    for e in msp:
        t = e.dxftype()
        counts[t] = counts.get(t, 0) + 1
    total = sum(counts.values())
    line_count = counts.get('LINE', 0) + counts.get('LWPOLYLINE', 0)
    has_blocks = counts.get('INSERT', 0) > 0
    is_flattened = (line_count / max(total, 1)) > 0.90 and not has_blocks
    log(f"Entities: {total}, Flattened: {is_flattened}")

    # ---- Batch collect ALL geometry into arrays ----
    log("Collecting geometry...")
    t0 = time.time()
    line_xs, line_ys = [], []
    poly_xs, poly_ys = [], []
    pts_x, pts_y = [], []

    for e in msp:
        try:
            if e.dxftype() == 'LINE':
                s, end = e.dxf.start, e.dxf.end
                line_xs.extend([s.x, end.x, None])
                line_ys.extend([s.y, end.y, None])
                pts_x.extend([s.x, end.x])
                pts_y.extend([s.y, end.y])
            elif e.dxftype() == 'LWPOLYLINE':
                pts = list(e.get_points(format='xy'))
                if len(pts) >= 2:
                    for p in pts:
                        poly_xs.append(p[0]); poly_ys.append(p[1])
                        pts_x.append(p[0]); pts_y.append(p[1])
                    if e.closed:
                        poly_xs.append(pts[0][0]); poly_ys.append(pts[0][1])
                    poly_xs.append(None); poly_ys.append(None)
            elif e.dxftype() == 'CIRCLE':
                c = e.dxf.center
                pts_x.append(c.x); pts_y.append(c.y)
            elif e.dxftype() == 'ARC':
                c = e.dxf.center
                pts_x.append(c.x); pts_y.append(c.y)
            elif e.dxftype() == 'INSERT' and not is_flattened:
                try:
                    for ve in e.virtual_entities():
                        if ve.dxftype() in ('TEXT', 'MTEXT'):
                            continue
                        if ve.dxftype() == 'LINE':
                            s, end = ve.dxf.start, ve.dxf.end
                            line_xs.extend([s.x, end.x, None])
                            line_ys.extend([s.y, end.y, None])
                            pts_x.extend([s.x, end.x])
                            pts_y.extend([s.y, end.y])
                        elif ve.dxftype() == 'LWPOLYLINE':
                            vpts = list(ve.get_points(format='xy'))
                            if len(vpts) >= 2:
                                for p in vpts:
                                    poly_xs.append(p[0]); poly_ys.append(p[1])
                                    pts_x.append(p[0]); pts_y.append(p[1])
                                if ve.closed:
                                    poly_xs.append(vpts[0][0]); poly_ys.append(vpts[0][1])
                                poly_xs.append(None); poly_ys.append(None)
                except:
                    pass
        except:
            pass

    collect_time = time.time() - t0
    log(f"Collected {len(pts_x)} points in {collect_time:.1f}s")

    if len(pts_x) < 10:
        print(json.dumps({'success': False, 'error': 'No geometry found'}))
        return

    # ---- Calculate bounds (percentile to exclude outliers) ----
    ax_arr = np.array(pts_x, dtype=np.float64)
    ay_arr = np.array(pts_y, dtype=np.float64)
    xmin, xmax = float(np.percentile(ax_arr, 1)), float(np.percentile(ax_arr, 99))
    ymin, ymax = float(np.percentile(ay_arr, 1)), float(np.percentile(ay_arr, 99))
    pad = max(xmax - xmin, ymax - ymin) * 0.02
    xmin -= pad; xmax += pad; ymin -= pad; ymax += pad
    width = xmax - xmin
    height = ymax - ymin
    aspect = width / max(height, 1)
    log(f"Bounds: X[{xmin:.1f}, {xmax:.1f}] Y[{ymin:.1f}, {ymax:.1f}] Aspect: {aspect:.1f}:1")

    def batch_render(ax_obj, lw=0.25):
        """Draw all collected geometry onto a matplotlib axes."""
        if line_xs:
            ax_obj.plot(line_xs, line_ys, color='black', linewidth=lw, solid_capstyle='round')
        if poly_xs:
            ax_obj.plot(poly_xs, poly_ys, color='black', linewidth=lw, solid_capstyle='round')

    def save_image(fig_obj, path, max_px=5000, dpi=300):
        """Save figure and resize if too large for Claude API."""
        fig_obj.savefig(path, dpi=dpi, bbox_inches='tight', facecolor='white', pad_inches=0.2)
        plt.close(fig_obj)
        img = Image.open(path)
        w, h = img.size
        if w > max_px or h > max_px:
            ratio = min(max_px / w, max_px / h)
            new_w, new_h = int(w * ratio), int(h * ratio)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            img.save(path, quality=95)
            log(f"  Resized {w}x{h} -> {new_w}x{new_h}")
        return w, h

    # ---- Render overview ----
    log("Rendering overview...")
    t0 = time.time()
    fig_h = 12  # taller for better quality
    fig_w = min(fig_h * aspect, 120)
    fig, ax = plt.subplots(1, 1, figsize=(max(fig_w, 6), fig_h))
    ax.set_facecolor('white'); ax.set_aspect('equal'); ax.axis('off')
    ax.set_xlim(xmin, xmax); ax.set_ylim(ymin, ymax)
    batch_render(ax, lw=0.2)  # slightly thinner for overview
    overview_path = os.path.join(output_dir, 'overview.png')
    save_image(fig, overview_path, max_px=6000, dpi=250)
    render_time = time.time() - t0
    log(f"Overview: {os.path.getsize(overview_path)//1024}KB in {render_time:.1f}s")

    # ---- Split into zones ----
    zones = []

    if aspect > 5:
        # ============================================
        # WIDE MULTI-SHEET LAYOUT — SECTION DETECTION
        # ============================================
        log(f"Wide layout ({aspect:.0f}:1) — detecting sections by X gaps...")

        # Histogram of X coords to find gaps between plan sheets
        filtered = ax_arr[(ax_arr >= xmin) & (ax_arr <= xmax)]
        hist, edges = np.histogram(filtered, bins=300)
        threshold = max(hist) * 0.01
        gap_indices = np.where(hist < threshold)[0]

        sections = []
        sec_start = xmin
        min_w = width * 0.03  # minimum 3% of total width

        for idx in gap_indices:
            gap_x = float((edges[idx] + edges[idx + 1]) / 2)
            if gap_x - sec_start > min_w:
                sections.append((sec_start, gap_x))
                sec_start = gap_x
        if xmax - sec_start > min_w:
            sections.append((sec_start, xmax))

        # NO MERGING — use raw sections as-is (merging was causing all sections to become 1)
        log(f"Found {len(sections)} sections")

        for i, (sx0, sx1) in enumerate(sections):
            sw = sx1 - sx0
            sa = sw / max(height, 1)
            sf_h = 15
            sf_w = max(min(sf_h * sa, 40), 4)  # between 4 and 40 inches to prevent huge images

            fig, ax = plt.subplots(1, 1, figsize=(sf_w, sf_h))
            ax.set_facecolor('white'); ax.set_aspect('equal'); ax.axis('off')
            ax.set_xlim(sx0, sx1); ax.set_ylim(ymin, ymax)

            # Use thicker lines so they're visible in compressed images
            lw = 0.3  # was 0.2
            if line_xs:
                ax.plot(line_xs, line_ys, color='black', linewidth=lw, solid_capstyle='round')
            if poly_xs:
                ax.plot(poly_xs, poly_ys, color='black', linewidth=lw, solid_capstyle='round')

            zpath = os.path.join(output_dir, f'zone_{i}.png')
            img_w, img_h = save_image(fig, zpath, max_px=5000, dpi=200)  # 200 DPI to avoid huge images

            size_kb = os.path.getsize(zpath) // 1024
            zones.append({
                'zone_id': i,
                'image_path': zpath,
                'bounds': {'x_min': sx0, 'x_max': sx1, 'y_min': ymin, 'y_max': ymax},
                'size_kb': size_kb,
                'dimensions': [img_w, img_h]
            })

            # Warn if section is suspiciously small (probably blank)
            if size_kb < 50:
                log(f"  ⚠️ Section {i}: X[{sx0:.0f}-{sx1:.0f}] {img_w}x{img_h} -> {size_kb}KB — LIKELY BLANK!")
            else:
                log(f"  Section {i}: X[{sx0:.0f}-{sx1:.0f}] {img_w}x{img_h} -> {size_kb}KB")

    else:
        # ============================================
        # NORMAL ASPECT — USE 3x3 GRID WITH OVERLAP
        # ============================================
        log("Normal aspect — using 3x3 grid...")

        for row in range(3):
            for col in range(3):
                # 10% overlap between zones
                zw = width / 2.7
                zh = height / 2.7
                zx0 = xmin + col * (width - zw) / 2
                zy0 = ymin + row * (height - zh) / 2
                zx1 = zx0 + zw
                zy1 = zy0 + zh

                fig, ax = plt.subplots(1, 1, figsize=(16, 16))  # was 15
                ax.set_facecolor('white'); ax.set_aspect('equal'); ax.axis('off')
                ax.set_xlim(zx0, zx1); ax.set_ylim(zy0, zy1)
                batch_render(ax, lw=0.3)  # thicker lines

                zone_idx = row * 3 + col
                zpath = os.path.join(output_dir, f'zone_{zone_idx}.png')
                img_w, img_h = save_image(fig, zpath, max_px=5000, dpi=300)

                size_kb = os.path.getsize(zpath) // 1024
                zones.append({
                    'zone_id': zone_idx,
                    'image_path': zpath,
                    'bounds': {'x_min': zx0, 'x_max': zx1, 'y_min': zy0, 'y_max': zy1},
                    'size_kb': size_kb,
                    'dimensions': [img_w, img_h]
                })
                log(f"  Zone {zone_idx}: {size_kb}KB")

    total_time = time.time() - start
    log(f"Done in {total_time:.1f}s — {len(zones)} zones")

    # ---- OUTPUT (only JSON on stdout) ----
    result = {
        'success': True,
        'version': 'analyze_dxf v8.3',
        'is_flattened': is_flattened,
        'total_entities': total,
        'entity_counts': counts,
        'bounds': {'x_min': xmin, 'x_max': xmax, 'y_min': ymin, 'y_max': ymax},
        'aspect_ratio': round(aspect, 1),
        'split_method': 'section_detection' if aspect > 5 else 'grid_3x3',
        'overview_image': overview_path,
        'zones': zones,
        'total_zones': len(zones),
        'timing': {
            'load': round(load_time, 1),
            'collect': round(collect_time, 1),
            'render': round(render_time, 1),
            'total': round(total_time, 1)
        }
    }
    print(json.dumps(result))

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({'success': False, 'error': 'Usage: analyze_dxf.py <dxf_path> <output_dir>'}))
        sys.exit(1)
    analyze(sys.argv[1], sys.argv[2])
