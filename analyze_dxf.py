#!/usr/bin/env python3
"""
DXF Fire Safety Analyzer - Python Pipeline
Renders DXF to high-res image using ezdxf + matplotlib, then outputs for Claude Vision analysis.

v7: HYBRID SPATIAL ANALYSIS
    - Splits drawing into overlapping zones
    - Extracts TEXT/MTEXT/INSERT entities with pixel coordinates per zone
    - Outputs hybrid JSON: zone images + entity data for context-aware AI analysis
    - CoordinateTransformer maps DXF world coords to PNG pixel coords

v6: SMART BOUNDS - Percentile-based bounds exclude outlier points
    - Outliers (title block xrefs, north arrows) don't destroy view
    - Uses 2nd/98th percentile + IQR fallback for concentrated content
    - NEVER uses autoscale_view (single outlier makes drawing invisible)

Usage:
    python analyze_dxf.py input.dxf --output /tmp/output_dir --json
"""

import os
import sys
import json
import argparse
import tempfile
from datetime import datetime

import numpy as np


def log(msg):
    """Print log message to stderr (not stdout) to keep JSON output clean."""
    print(msg, file=sys.stderr)


# Try to import dependencies
try:
    import ezdxf
except ImportError:
    log("ERROR: ezdxf not installed. Run: pip install ezdxf")
    sys.exit(1)

try:
    import matplotlib
    matplotlib.use('Agg')  # Headless rendering
    import matplotlib.pyplot as plt
    from matplotlib.patches import Arc
except ImportError:
    log("ERROR: matplotlib not installed. Run: pip install matplotlib")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    log("ERROR: Pillow not installed. Run: pip install Pillow")
    sys.exit(1)


def ensure_max_size(image_path, max_dim=7000):
    """Resize image if any dimension exceeds max_dim (Claude limit is 8000px)."""
    img = Image.open(image_path)
    w, h = img.size
    if w > max_dim or h > max_dim:
        ratio = min(max_dim / w, max_dim / h)
        new_size = (int(w * ratio), int(h * ratio))
        img = img.resize(new_size, Image.LANCZOS)
        img.save(image_path)
        log(f"   Resized: {w}x{h} -> {new_size[0]}x{new_size[1]} (max {max_dim}px)")
    return image_path


class CoordinateTransformer:
    """Maps DXF world coordinates to PNG pixel coordinates."""

    def __init__(self, world_bounds, image_size):
        """
        Args:
            world_bounds: tuple (xmin, xmax, ymin, ymax) in DXF world coordinates
            image_size: tuple (width, height) in pixels
        """
        self.world_xmin, self.world_xmax = world_bounds[0], world_bounds[1]
        self.world_ymin, self.world_ymax = world_bounds[2], world_bounds[3]
        self.img_width, self.img_height = image_size

        # Calculate scale factors
        world_width = self.world_xmax - self.world_xmin
        world_height = self.world_ymax - self.world_ymin

        self.scale_x = self.img_width / world_width if world_width > 0 else 1
        self.scale_y = self.img_height / world_height if world_height > 0 else 1

    def world_to_pixel(self, x, y):
        """Convert DXF world coords to PNG pixel coords."""
        px = (x - self.world_xmin) * self.scale_x
        py = self.img_height - (y - self.world_ymin) * self.scale_y  # Y flipped
        return int(px), int(py)

    def to_dict(self):
        """Serialize transform for JSON output."""
        return {
            'world_bounds': [self.world_xmin, self.world_xmax, self.world_ymin, self.world_ymax],
            'image_size': [self.img_width, self.img_height],
            'scale': [self.scale_x, self.scale_y]
        }


def read_dxf_safe(filepath):
    """Read DXF with proper Hebrew encoding handling."""
    # First try normal read (ezdxf handles codepage)
    try:
        doc = ezdxf.readfile(filepath)
        log(f"   Loaded DXF with default encoding")
        return doc
    except Exception as e:
        log(f"   Default read failed: {e}")

    # Try forcing cp1255 (Hebrew Windows codepage)
    try:
        doc = ezdxf.readfile(filepath, encoding='cp1255')
        log(f"   Loaded DXF with cp1255 encoding")
        return doc
    except Exception as e:
        log(f"   cp1255 read failed: {e}")

    # Try ISO-8859-8 (Hebrew ISO)
    try:
        doc = ezdxf.readfile(filepath, encoding='iso-8859-8')
        log(f"   Loaded DXF with iso-8859-8 encoding")
        return doc
    except Exception as e:
        log(f"   iso-8859-8 read failed: {e}")

    # Last resort: read as bytes, transcode, save temp, re-read
    try:
        with open(filepath, 'rb') as f:
            raw = f.read()

        text = raw.decode('cp1255', errors='replace')
        text = text.replace('ANSI_1255', 'UTF-8')
        text = text.replace('ansi_1255', 'UTF-8')

        tmp = tempfile.NamedTemporaryFile(suffix='.dxf', delete=False, mode='w', encoding='utf-8')
        tmp.write(text)
        tmp.close()

        doc = ezdxf.readfile(tmp.name)
        os.unlink(tmp.name)
        log(f"   Loaded DXF via transcoding workaround")
        return doc
    except Exception as e:
        log(f"   Transcoding workaround failed: {e}")

    raise RuntimeError(f"Cannot read DXF with any encoding method")


def get_color(entity, default='#000000'):
    """Get visible color for entity. Never return white."""
    aci_map = {
        1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
        5: '#0000FF', 6: '#FF00FF', 8: '#808080', 9: '#C0C0C0',
    }
    try:
        c = entity.dxf.get('color', 7)
        if c == 7 or c == 0 or c == 256:
            return '#000000'  # NEVER white on white background
        return aci_map.get(c, default)
    except:
        return default


def calculate_smart_bounds(all_x, all_y, margin=0.1):
    """Calculate bounds using percentiles to exclude outlier points."""
    if len(all_x) == 0 or len(all_y) == 0:
        return 0, 100, 0, 100

    ax = np.array(all_x)
    ay = np.array(all_y)

    # Use 2nd and 98th percentile to exclude extreme outliers
    xmin = np.percentile(ax, 2)
    xmax = np.percentile(ax, 98)
    ymin = np.percentile(ay, 2)
    ymax = np.percentile(ay, 98)

    # Add margin
    xspan = xmax - xmin
    yspan = ymax - ymin

    # If span is suspiciously small compared to full range, use IQR method
    full_xspan = ax.max() - ax.min()
    full_yspan = ay.max() - ay.min()

    if full_xspan > 0 and (xspan < full_xspan * 0.01):
        # Content is extremely concentrated — use tight IQR bounds
        q1x, q3x = np.percentile(ax, 10), np.percentile(ax, 90)
        iqrx = q3x - q1x
        xmin = q1x - 2 * iqrx
        xmax = q3x + 2 * iqrx

    if full_yspan > 0 and (yspan < full_yspan * 0.01):
        q1y, q3y = np.percentile(ay, 10), np.percentile(ay, 90)
        iqry = q3y - q1y
        ymin = q1y - 2 * iqry
        ymax = q3y + 2 * iqry

    # Add margin
    xpad = max((xmax - xmin) * margin, 1)
    ypad = max((ymax - ymin) * margin, 1)

    return xmin - xpad, xmax + xpad, ymin - ypad, ymax + ypad


def collect_all_points(msp):
    """Collect coordinates from all entities including expanded blocks."""
    all_x, all_y = [], []

    def collect(e):
        try:
            etype = e.dxftype()
            if etype == 'LINE':
                all_x.extend([e.dxf.start.x, e.dxf.end.x])
                all_y.extend([e.dxf.start.y, e.dxf.end.y])
            elif etype == 'LWPOLYLINE':
                for pt in e.get_points(format='xy'):
                    all_x.append(pt[0])
                    all_y.append(pt[1])
            elif etype == 'POLYLINE':
                try:
                    for v in e.vertices:
                        all_x.append(v.dxf.location.x)
                        all_y.append(v.dxf.location.y)
                except:
                    pass
            elif etype in ('CIRCLE', 'ARC'):
                all_x.append(e.dxf.center.x)
                all_y.append(e.dxf.center.y)
            elif etype == 'POINT':
                all_x.append(e.dxf.location.x)
                all_y.append(e.dxf.location.y)
            elif etype == 'ELLIPSE':
                all_x.append(e.dxf.center.x)
                all_y.append(e.dxf.center.y)
        except:
            pass

    for e in msp:
        if e.dxftype() == 'INSERT':
            try:
                for ve in e.virtual_entities():
                    collect(ve)
            except:
                pass
        else:
            collect(e)

    return all_x, all_y


def extract_zone_entities(msp, zone_bounds, transformer):
    """Extract TEXT/MTEXT/INSERT entities within zone bounds with pixel coordinates."""
    entities = []
    xmin, xmax, ymin, ymax = zone_bounds

    for entity in msp:
        try:
            etype = entity.dxftype()

            if etype == 'TEXT':
                pos = entity.dxf.insert
                if xmin <= pos.x <= xmax and ymin <= pos.y <= ymax:
                    px, py = transformer.world_to_pixel(pos.x, pos.y)
                    text = safe_text(entity.dxf.text) if hasattr(entity.dxf, 'text') else ''
                    entities.append({
                        'type': 'TEXT',
                        'text': text,
                        'world_pos': [float(pos.x), float(pos.y)],
                        'pixel_pos': [px, py],
                        'height': float(entity.dxf.height) if hasattr(entity.dxf, 'height') else 0
                    })

            elif etype == 'MTEXT':
                pos = entity.dxf.insert
                if xmin <= pos.x <= xmax and ymin <= pos.y <= ymax:
                    px, py = transformer.world_to_pixel(pos.x, pos.y)
                    text = safe_text(entity.text) if hasattr(entity, 'text') else ''
                    entities.append({
                        'type': 'MTEXT',
                        'text': text,
                        'world_pos': [float(pos.x), float(pos.y)],
                        'pixel_pos': [px, py]
                    })

            elif etype == 'INSERT':
                pos = entity.dxf.insert
                if xmin <= pos.x <= xmax and ymin <= pos.y <= ymax:
                    px, py = transformer.world_to_pixel(pos.x, pos.y)
                    entities.append({
                        'type': 'BLOCK',
                        'name': entity.dxf.name,
                        'world_pos': [float(pos.x), float(pos.y)],
                        'pixel_pos': [px, py]
                    })

        except Exception:
            pass

    return entities


def calculate_zones_with_overlap(bounds, num_zones=10, overlap_percent=0.05):
    """Split bounds into overlapping zones for comprehensive coverage."""
    xmin, xmax, ymin, ymax = bounds
    width = xmax - xmin
    height = ymax - ymin

    if width <= 0 or height <= 0:
        return [{'id': 'zone_0_0', 'bounds': bounds, 'grid_pos': [0, 0]}]

    # Determine grid (e.g., 4x3 = 12 zones, or 5x2 = 10)
    aspect = width / height
    cols = max(1, int(np.ceil(np.sqrt(num_zones * aspect))))
    rows = max(1, int(np.ceil(num_zones / cols)))

    zone_width = width / cols
    zone_height = height / rows
    overlap_x = zone_width * overlap_percent
    overlap_y = zone_height * overlap_percent

    zones = []
    for row in range(rows):
        for col in range(cols):
            z_xmin = xmin + col * zone_width - overlap_x
            z_xmax = xmin + (col + 1) * zone_width + overlap_x
            z_ymin = ymin + row * zone_height - overlap_y
            z_ymax = ymin + (row + 1) * zone_height + overlap_y

            # Clamp to global bounds
            z_xmin = max(z_xmin, xmin - overlap_x)
            z_xmax = min(z_xmax, xmax + overlap_x)
            z_ymin = max(z_ymin, ymin - overlap_y)
            z_ymax = min(z_ymax, ymax + overlap_y)

            zones.append({
                'id': f'zone_{row}_{col}',
                'bounds': [z_xmin, z_xmax, z_ymin, z_ymax],
                'grid_pos': [row, col]
            })

    return zones


def render_dxf(dxf_path, output_path, dpi=150):
    """
    Render DXF to PNG with SMART BOUNDS.
    - Collects all coordinates including expanded blocks
    - Uses percentile-based bounds to exclude outliers
    - NEVER uses autoscale (outliers would make drawing invisible)
    """
    log(f"   Using SMART BOUNDS renderer v6...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    # Count entities
    msp_list = list(msp)
    type_counts = {}
    for e in msp_list:
        t = e.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1

    log(f"   Modelspace: {len(msp_list)} entities")
    log(f"   Types: {dict(sorted(type_counts.items(), key=lambda x: -x[1])[:8])}")

    # Step 1: Collect all points to calculate smart bounds
    log("   Collecting geometry points...")
    all_x, all_y = collect_all_points(msp)
    log(f"   Total points collected: {len(all_x)}")

    if len(all_x) == 0:
        log("   ERROR: No geometry points found!")
        # Fall back to document extents
        try:
            extmin = doc.header.get('$EXTMIN', (0, 0, 0))
            extmax = doc.header.get('$EXTMAX', (100, 100, 0))
            xmin, xmax = float(extmin[0]), float(extmax[0])
            ymin, ymax = float(extmin[1]), float(extmax[1])
            log(f"   Using document extents: X[{xmin:.1f}, {xmax:.1f}] Y[{ymin:.1f}, {ymax:.1f}]")
        except:
            xmin, xmax, ymin, ymax = 0, 100, 0, 100
    else:
        # Log full range vs percentile range
        full_xmin, full_xmax = min(all_x), max(all_x)
        full_ymin, full_ymax = min(all_y), max(all_y)
        log(f"   Full range: X[{full_xmin:.1f}, {full_xmax:.1f}] Y[{full_ymin:.1f}, {full_ymax:.1f}]")
        log(f"   Full span: {full_xmax - full_xmin:.1f} x {full_ymax - full_ymin:.1f}")

        xmin, xmax, ymin, ymax = calculate_smart_bounds(all_x, all_y)

    log(f"   Smart bounds: X[{xmin:.1f}, {xmax:.1f}] Y[{ymin:.1f}, {ymax:.1f}]")
    log(f"   Smart span: {xmax - xmin:.1f} x {ymax - ymin:.1f}")

    # Step 2: Create figure with correct aspect ratio
    span_x = xmax - xmin
    span_y = ymax - ymin
    aspect = span_x / span_y if span_y > 0 else 1
    fig_h = 40
    fig_w = fig_h * aspect
    fig_w = min(max(fig_w, 20), 80)  # clamp between 20 and 80

    log(f"   Figure size: {fig_w:.1f} x {fig_h:.1f}")

    fig, ax = plt.subplots(1, 1, figsize=(fig_w, fig_h))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)

    # Step 3: Draw all entities
    drawn = 0
    skipped_text = 0

    def draw_entity(e):
        nonlocal drawn, skipped_text
        try:
            etype = e.dxftype()

            # Skip ALL text - Hebrew causes garbled output
            if etype in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'):
                skipped_text += 1
                return

            color = get_color(e)

            if etype == 'LINE':
                s, end = e.dxf.start, e.dxf.end
                ax.plot([s.x, end.x], [s.y, end.y], color=color, linewidth=0.5)
                drawn += 1

            elif etype == 'LWPOLYLINE':
                pts = list(e.get_points(format='xy'))
                if len(pts) >= 2:
                    xs, ys = zip(*pts)
                    xs, ys = list(xs), list(ys)
                    if e.closed:
                        xs.append(xs[0])
                        ys.append(ys[0])
                    ax.plot(xs, ys, color=color, linewidth=0.5)
                    drawn += 1

            elif etype == 'POLYLINE':
                try:
                    pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                    if len(pts) >= 2:
                        xs, ys = zip(*pts)
                        ax.plot(xs, ys, color=color, linewidth=0.5)
                        drawn += 1
                except:
                    pass

            elif etype == 'CIRCLE':
                c = e.dxf.center
                r = e.dxf.radius
                circle = plt.Circle((c.x, c.y), r, fill=False, color=color, linewidth=0.5)
                ax.add_patch(circle)
                drawn += 1

            elif etype == 'ARC':
                c = e.dxf.center
                r = e.dxf.radius
                arc = Arc((c.x, c.y), 2*r, 2*r, angle=0,
                         theta1=e.dxf.start_angle, theta2=e.dxf.end_angle,
                         color=color, linewidth=0.5)
                ax.add_patch(arc)
                drawn += 1

            elif etype == 'POINT':
                p = e.dxf.location
                ax.plot(p.x, p.y, '.', color=color, markersize=1)
                drawn += 1

            elif etype == 'ELLIPSE':
                try:
                    c = e.dxf.center
                    major = e.dxf.major_axis
                    ratio = e.dxf.ratio
                    import math
                    a = (major.x**2 + major.y**2)**0.5
                    b = a * ratio
                    angle = math.degrees(math.atan2(major.y, major.x))
                    from matplotlib.patches import Ellipse
                    ellipse = Ellipse((c.x, c.y), 2*a, 2*b, angle=angle,
                                      fill=False, color=color, linewidth=0.5)
                    ax.add_patch(ellipse)
                    drawn += 1
                except:
                    pass

            elif etype == 'SPLINE':
                try:
                    pts = list(e.control_points)
                    if len(pts) >= 2:
                        xs = [p[0] for p in pts]
                        ys = [p[1] for p in pts]
                        ax.plot(xs, ys, color=color, linewidth=0.5)
                        drawn += 1
                except:
                    pass

        except Exception:
            pass

    # Pass 1: Draw all direct entities (not INSERTs)
    for entity in msp_list:
        if entity.dxftype() != 'INSERT':
            draw_entity(entity)

    log(f"   Pass 1 (direct): {drawn} drawn, {skipped_text} text skipped")
    pass1_drawn = drawn

    # Pass 2: Expand ALL block references and draw their contents
    insert_count = 0
    blocks_with_content = 0

    for entity in msp_list:
        if entity.dxftype() == 'INSERT':
            insert_count += 1
            try:
                ves = list(entity.virtual_entities())

                if len(ves) > 0:
                    blocks_with_content += 1

                for ve in ves:
                    # Handle nested INSERTs recursively
                    if ve.dxftype() == 'INSERT':
                        try:
                            for nested in ve.virtual_entities():
                                draw_entity(nested)
                        except:
                            pass
                    else:
                        draw_entity(ve)

            except Exception as ex:
                pass

    pass2_drawn = drawn - pass1_drawn
    log(f"   Pass 2 (blocks): {insert_count} INSERTs, {blocks_with_content} had content, {pass2_drawn} entities drawn")
    log(f"   TOTAL: {drawn} entities drawn, {skipped_text} text skipped")

    # Save figure
    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.3)
    plt.close(fig)

    # Check output size
    size_kb = os.path.getsize(output_path) / 1024
    log(f"   Saved: {output_path} ({size_kb:.0f}KB)")

    if size_kb < 50:
        log("   WARNING: Image very small — likely blank!")
    elif size_kb > 500:
        log("   SUCCESS: Image has substantial content")

    return output_path


def split_into_zones(image_path, output_dir, grid=(3, 3)):
    """Split rendered image into zones + create overview (legacy function)."""
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(image_path)
    w, h = img.size

    log(f"   Image size: {w}x{h}")

    cols, rows = grid
    zone_w, zone_h = w // cols, h // rows

    paths = []

    # Overview (resized to 2048 max)
    overview = img.copy()
    overview.thumbnail((2048, 2048), Image.LANCZOS)
    overview_path = os.path.join(output_dir, 'overview.jpg')
    overview.convert('RGB').save(overview_path, 'JPEG', quality=90)
    paths.append(overview_path)

    # Zones
    for r in range(rows):
        for c in range(cols):
            box = (c * zone_w, r * zone_h, (c + 1) * zone_w, (r + 1) * zone_h)
            zone = img.crop(box)
            zone_path = os.path.join(output_dir, f'zone_{r}_{c}.jpg')
            zone.convert('RGB').save(zone_path, 'JPEG', quality=90)
            paths.append(zone_path)

    log(f"   Created {len(paths)} images (1 overview + {rows*cols} zones)")
    return paths


def split_into_hybrid_zones(image_path, output_dir, msp, global_bounds, num_zones=10, overlap_percent=0.05):
    """
    Split rendered image into overlapping zones with entity data.

    Returns:
        dict with hybrid zone data including images, bounds, transforms, and entities
    """
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(image_path)
    img_w, img_h = img.size

    log(f"   Image size: {img_w}x{img_h}")

    # Calculate zones in DXF world coordinates
    zones_config = calculate_zones_with_overlap(global_bounds, num_zones, overlap_percent)
    log(f"   Calculated {len(zones_config)} zones with {overlap_percent*100:.0f}% overlap")

    # Create global transformer (whole image)
    global_transformer = CoordinateTransformer(global_bounds, (img_w, img_h))

    # Overview (resized to 2048 max)
    overview = img.copy()
    overview.thumbnail((2048, 2048), Image.LANCZOS)
    overview_path = os.path.join(output_dir, 'overview.jpg')
    overview.convert('RGB').save(overview_path, 'JPEG', quality=90)

    hybrid_zones = []

    for zone_cfg in zones_config:
        zone_id = zone_cfg['id']
        zone_bounds = zone_cfg['bounds']  # [xmin, xmax, ymin, ymax] in DXF coords
        grid_pos = zone_cfg['grid_pos']

        # Convert zone DXF bounds to pixel bounds in the full image
        px1, py1 = global_transformer.world_to_pixel(zone_bounds[0], zone_bounds[3])  # top-left (ymax because Y flipped)
        px2, py2 = global_transformer.world_to_pixel(zone_bounds[1], zone_bounds[2])  # bottom-right (ymin)

        # Clamp to image bounds
        px1 = max(0, min(px1, img_w))
        px2 = max(0, min(px2, img_w))
        py1 = max(0, min(py1, img_h))
        py2 = max(0, min(py2, img_h))

        # Ensure valid crop box
        if px1 >= px2 or py1 >= py2:
            log(f"   Skipping {zone_id}: invalid crop box ({px1},{py1}) to ({px2},{py2})")
            continue

        # Crop zone from image
        zone_img = img.crop((px1, py1, px2, py2))
        zone_w, zone_h = zone_img.size

        if zone_w < 10 or zone_h < 10:
            log(f"   Skipping {zone_id}: too small ({zone_w}x{zone_h})")
            continue

        zone_path = os.path.join(output_dir, f'{zone_id}.jpg')
        zone_img.convert('RGB').save(zone_path, 'JPEG', quality=90)

        # Create transformer for this zone's coordinate space
        zone_transformer = CoordinateTransformer(zone_bounds, (zone_w, zone_h))

        # Extract entities within this zone's bounds
        entities = extract_zone_entities(msp, zone_bounds, zone_transformer)

        hybrid_zones.append({
            'zone_id': zone_id,
            'image_path': zone_path,
            'image_size': [zone_w, zone_h],
            'bounds': zone_bounds,
            'grid_position': grid_pos,
            'transform': zone_transformer.to_dict(),
            'entities': entities,
            'entity_count': len(entities)
        })

        log(f"   {zone_id}: {zone_w}x{zone_h}px, {len(entities)} entities")

    log(f"   Created {len(hybrid_zones)} hybrid zones")

    return {
        'overview': overview_path,
        'overview_size': list(overview.size),
        'global_bounds': list(global_bounds),
        'global_transform': global_transformer.to_dict(),
        'zones': hybrid_zones,
        'total_zones': len(hybrid_zones)
    }


def safe_text(s):
    """Sanitize text for metadata extraction (not rendering)."""
    if not s:
        return ''
    cleaned = ''
    for ch in s:
        try:
            code = ord(ch)
            if 0xD800 <= code <= 0xDFFF:
                continue
            if code > 0xFFFF:
                continue
            if code < 32 and code not in (9, 10, 13):
                continue
            ch.encode('utf-8')
            cleaned += ch
        except:
            continue
    return cleaned


def extract_metadata(dxf_path):
    """Extract structured metadata from DXF file."""
    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    # Count entities by type
    entity_counts = {}
    for e in msp:
        t = e.dxftype()
        entity_counts[t] = entity_counts.get(t, 0) + 1

    # Layers
    layers = [layer.dxf.name for layer in doc.layers]

    # All text content (sanitized) - for metadata only
    texts = []
    for e in msp.query('TEXT MTEXT'):
        try:
            raw = e.dxf.text if e.dxftype() == 'TEXT' else e.text
            t = safe_text(raw)
            if t:
                texts.append(t)
        except:
            pass

    # Block names used
    block_counts = {}
    for e in msp.query('INSERT'):
        try:
            name = e.dxf.name
            block_counts[name] = block_counts.get(name, 0) + 1
        except:
            pass

    # Fire-related keywords
    fire_keywords = ['כיבוי', 'אש', 'fire', 'sprink', 'hydrant', 'מתז', 'גלאי',
                     'מילוט', 'exit', 'alarm', 'smoke', 'עשן', 'גלגלון', 'מטף',
                     'חירום', 'emergency']
    fire_related_layers = [l for l in layers if any(k in l.lower() for k in fire_keywords)]
    fire_related_texts = [t for t in texts if any(k in t.lower() for k in fire_keywords)]

    # Get extents
    try:
        extmin = doc.header.get('$EXTMIN', (0, 0, 0))
        extmax = doc.header.get('$EXTMAX', (0, 0, 0))
    except:
        extmin = (0, 0, 0)
        extmax = (0, 0, 0)

    metadata = {
        'entity_counts': entity_counts,
        'total_entities': sum(entity_counts.values()),
        'layers': layers,
        'layer_count': len(layers),
        'texts_sample': texts[:100],
        'text_count': len(texts),
        'block_usage': dict(sorted(block_counts.items(), key=lambda x: -x[1])[:30]),
        'fire_related_layers': fire_related_layers,
        'fire_related_texts': fire_related_texts[:20],
        'extents': {
            'min_x': float(extmin[0]) if extmin else 0,
            'min_y': float(extmin[1]) if extmin else 0,
            'max_x': float(extmax[0]) if extmax else 0,
            'max_y': float(extmax[1]) if extmax else 0,
        }
    }

    return metadata


def main():
    parser = argparse.ArgumentParser(description='Render DXF to high-res image for fire safety analysis')
    parser.add_argument('input', help='Input DXF file path')
    parser.add_argument('--output', '-o', default='/tmp/dxf-analysis', help='Output directory')
    parser.add_argument('--dpi', type=int, default=150, help='Render DPI (default: 150)')
    parser.add_argument('--json', action='store_true', help='Output results as JSON to stdout')

    args = parser.parse_args()

    if not os.path.exists(args.input):
        log(f"ERROR: File not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    start = datetime.now()

    log('=' * 50)
    log('DXF RENDERER v7 (HYBRID SPATIAL ANALYSIS)')
    log(f'File: {os.path.basename(args.input)} ({os.path.getsize(args.input) / 1024 / 1024:.1f}MB)')
    log('=' * 50)

    # Step 1: Load DXF and calculate smart bounds
    log('Loading DXF and calculating bounds...')
    doc = read_dxf_safe(args.input)
    msp = doc.modelspace()

    all_x, all_y = collect_all_points(msp)
    if len(all_x) == 0:
        log("   ERROR: No geometry points found!")
        global_bounds = (0, 100, 0, 100)
    else:
        global_bounds = calculate_smart_bounds(all_x, all_y)

    log(f"   Smart bounds: X[{global_bounds[0]:.1f}, {global_bounds[1]:.1f}] Y[{global_bounds[2]:.1f}, {global_bounds[3]:.1f}]")

    # Step 2: Render DXF to PNG
    log('Rendering DXF to high-res PNG...')
    rendered_path = os.path.join(args.output, 'rendered_plan.png')
    render_dxf(args.input, rendered_path, dpi=args.dpi)

    # Step 2.5: Ensure image doesn't exceed Claude's 8000px limit
    ensure_max_size(rendered_path, max_dim=7000)

    # Step 3: Split into HYBRID zones with entity data
    log('Splitting into hybrid analysis zones...')
    hybrid_data = split_into_hybrid_zones(
        rendered_path, args.output, msp, global_bounds,
        num_zones=10, overlap_percent=0.05
    )

    # Collect all image paths for backward compatibility
    all_image_paths = [hybrid_data['overview']]
    for zone in hybrid_data['zones']:
        all_image_paths.append(zone['image_path'])

    # Step 4: Extract metadata
    log('Extracting DXF metadata...')
    metadata = extract_metadata(args.input)

    # Save metadata
    metadata_path = os.path.join(args.output, 'metadata.json')
    with open(metadata_path, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    # Save hybrid zone data
    hybrid_path = os.path.join(args.output, 'hybrid_zones.json')
    with open(hybrid_path, 'w', encoding='utf-8') as f:
        json.dump(hybrid_data, f, ensure_ascii=False, indent=2)

    elapsed = (datetime.now() - start).total_seconds()

    # Count total entities across all zones
    total_entities_extracted = sum(z['entity_count'] for z in hybrid_data['zones'])

    result = {
        'success': True,
        'version': 'v7-hybrid',
        'rendered_image': rendered_path,
        'overview': hybrid_data['overview'],
        'zones': [z['image_path'] for z in hybrid_data['zones']],
        'all_images': all_image_paths,
        'hybrid_data': hybrid_data,
        'hybrid_path': hybrid_path,
        'metadata': metadata,
        'metadata_path': metadata_path,
        'processing_time': elapsed,
        'total_entities_extracted': total_entities_extracted
    }

    log('=' * 50)
    log(f'Complete in {elapsed:.1f}s')
    log(f'Rendered: {rendered_path}')
    log(f'Hybrid zones: {hybrid_data["total_zones"]} (with entity data)')
    log(f'Entities extracted: {total_entities_extracted} (TEXT/MTEXT/INSERT)')
    log(f'DXF entities: {metadata["total_entities"]} total')
    log(f'Layers: {metadata["layer_count"]}')
    log('=' * 50)

    # ONLY the JSON result goes to stdout
    if args.json:
        print(json.dumps(result, ensure_ascii=False))

    return result


if __name__ == '__main__':
    main()
