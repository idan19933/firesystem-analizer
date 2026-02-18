#!/usr/bin/env python3
"""
DXF Fire Safety Analyzer - Python Pipeline

v8: FLATTENED DXF + BATCH RENDERING + AUTO-SECTION DETECTION
    - Detects flattened DXF files (no blocks/text/layers)
    - Uses batch rendering with None-separated arrays for 1M+ entities
    - Auto-detects plan sections by X-coordinate histogram gaps
    - Outputs sections as separate images for classification

v7: HYBRID SPATIAL ANALYSIS
    - Splits drawing into overlapping zones
    - Extracts TEXT/MTEXT/INSERT entities with pixel coordinates per zone
    - Outputs hybrid JSON: zone images + entity data for context-aware AI analysis

v6: SMART BOUNDS - Percentile-based bounds exclude outlier points

Usage:
    python analyze_dxf.py input.dxf --output /tmp/output_dir --json
    python analyze_dxf.py input.dxf --output /tmp/output_dir --json --sections
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
    from matplotlib.collections import LineCollection, PatchCollection
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

    # Use 1st and 99th percentile to exclude extreme outliers
    xmin = np.percentile(ax, 1)
    xmax = np.percentile(ax, 99)
    ymin = np.percentile(ay, 1)
    ymax = np.percentile(ay, 99)

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


def detect_flattened_dxf(msp, entity_counts, layers):
    """
    Detect if DXF is flattened (exploded, no semantic content).
    Returns True if file appears to be flattened.
    """
    total = sum(entity_counts.values())

    # Flattened indicators:
    # 1. No INSERT (blocks) or very few
    insert_count = entity_counts.get('INSERT', 0)
    insert_ratio = insert_count / total if total > 0 else 0

    # 2. No TEXT/MTEXT or very few
    text_count = entity_counts.get('TEXT', 0) + entity_counts.get('MTEXT', 0)
    text_ratio = text_count / total if total > 0 else 0

    # 3. Dominated by LINE/LWPOLYLINE/ARC (90%+)
    geometry_types = ['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'SPLINE']
    geometry_count = sum(entity_counts.get(t, 0) for t in geometry_types)
    geometry_ratio = geometry_count / total if total > 0 else 0

    # 4. Single layer "0" only
    meaningful_layers = [l for l in layers if l not in ('0', 'Defpoints', 'DEFPOINTS')]

    # 5. Very large entity count (100k+)
    is_large = total > 100000

    # Decision logic
    is_flattened = (
        insert_ratio < 0.01 and  # Less than 1% blocks
        text_ratio < 0.001 and   # Less than 0.1% text
        geometry_ratio > 0.95 and  # Over 95% geometry
        len(meaningful_layers) < 5  # Few meaningful layers
    )

    log(f"   Flattened check: INSERT={insert_ratio:.1%}, TEXT={text_ratio:.1%}, GEOMETRY={geometry_ratio:.1%}, layers={len(meaningful_layers)}")
    log(f"   Detected as: {'FLATTENED' if is_flattened else 'NORMAL'} ({'large' if is_large else 'standard'} file)")

    return is_flattened


def detect_sections_by_x_histogram(all_x, min_gap_ratio=0.1, min_points_per_section=1000):
    """
    Detect plan sections by finding gaps in X-coordinate histogram.

    Args:
        all_x: List of all X coordinates
        min_gap_ratio: Minimum gap size as ratio of total width
        min_points_per_section: Minimum points required for a valid section

    Returns:
        List of section bounds: [(xmin1, xmax1), (xmin2, xmax2), ...]
    """
    if len(all_x) < min_points_per_section:
        return []

    ax = np.array(all_x)

    # Create histogram with 200 bins
    num_bins = 200
    hist, bin_edges = np.histogram(ax, bins=num_bins)
    bin_width = bin_edges[1] - bin_edges[0]

    total_width = ax.max() - ax.min()
    min_gap_bins = int(min_gap_ratio * num_bins)

    log(f"   X-histogram: {num_bins} bins, width={bin_width:.1f}, total_span={total_width:.1f}")

    # Find empty/sparse regions (gaps)
    threshold = np.percentile(hist[hist > 0], 5) if len(hist[hist > 0]) > 0 else 1

    # Detect continuous sections
    sections = []
    in_section = False
    section_start = None
    gap_count = 0

    for i, count in enumerate(hist):
        if count > threshold:
            if not in_section:
                # Start new section
                section_start = bin_edges[i]
                in_section = True
                gap_count = 0
            else:
                gap_count = 0
        else:
            if in_section:
                gap_count += 1
                if gap_count >= min_gap_bins:
                    # End section
                    section_end = bin_edges[i - gap_count + 1]
                    sections.append((section_start, section_end))
                    in_section = False

    # Handle last section
    if in_section:
        sections.append((section_start, bin_edges[-1]))

    # Filter sections by minimum content
    valid_sections = []
    for xmin, xmax in sections:
        points_in_section = np.sum((ax >= xmin) & (ax <= xmax))
        if points_in_section >= min_points_per_section:
            valid_sections.append((xmin, xmax))
            log(f"   Section: X[{xmin:.0f}, {xmax:.0f}] - {points_in_section:,} points")
        else:
            log(f"   Skipped small section: X[{xmin:.0f}, {xmax:.0f}] - {points_in_section} points")

    log(f"   Detected {len(valid_sections)} sections from X-histogram")

    return valid_sections


def collect_geometry_batch(msp, bounds=None):
    """
    Collect all geometry into batch arrays using None-separators.
    This is CRITICAL for performance with 1M+ entities.

    Returns:
        dict with 'lines', 'circles', 'arcs' arrays ready for batch plotting
    """
    lines_x, lines_y = [], []
    circles = []  # List of (cx, cy, r)
    arcs = []     # List of (cx, cy, r, start_angle, end_angle)

    xmin, xmax, ymin, ymax = bounds if bounds else (-float('inf'), float('inf'), -float('inf'), float('inf'))

    def in_bounds(x, y):
        return xmin <= x <= xmax and ymin <= y <= ymax

    def add_line(x1, y1, x2, y2):
        if bounds is None or (in_bounds(x1, y1) or in_bounds(x2, y2)):
            lines_x.extend([x1, x2, None])
            lines_y.extend([y1, y2, None])

    def process_entity(e):
        try:
            etype = e.dxftype()

            if etype == 'LINE':
                add_line(e.dxf.start.x, e.dxf.start.y, e.dxf.end.x, e.dxf.end.y)

            elif etype == 'LWPOLYLINE':
                pts = list(e.get_points(format='xy'))
                if len(pts) >= 2:
                    for i in range(len(pts) - 1):
                        add_line(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1])
                    if e.closed and len(pts) >= 2:
                        add_line(pts[-1][0], pts[-1][1], pts[0][0], pts[0][1])

            elif etype == 'POLYLINE':
                try:
                    pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
                    if len(pts) >= 2:
                        for i in range(len(pts) - 1):
                            add_line(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1])
                except:
                    pass

            elif etype == 'CIRCLE':
                cx, cy = e.dxf.center.x, e.dxf.center.y
                if bounds is None or in_bounds(cx, cy):
                    circles.append((cx, cy, e.dxf.radius))

            elif etype == 'ARC':
                cx, cy = e.dxf.center.x, e.dxf.center.y
                if bounds is None or in_bounds(cx, cy):
                    arcs.append((cx, cy, e.dxf.radius, e.dxf.start_angle, e.dxf.end_angle))

            elif etype == 'SPLINE':
                try:
                    pts = list(e.control_points)
                    if len(pts) >= 2:
                        for i in range(len(pts) - 1):
                            add_line(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1])
                except:
                    pass

        except Exception:
            pass

    # Process all entities
    for entity in msp:
        if entity.dxftype() == 'INSERT':
            try:
                for ve in entity.virtual_entities():
                    if ve.dxftype() == 'INSERT':
                        try:
                            for nested in ve.virtual_entities():
                                process_entity(nested)
                        except:
                            pass
                    else:
                        process_entity(ve)
            except:
                pass
        elif entity.dxftype() not in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'):
            process_entity(entity)

    return {
        'lines_x': lines_x,
        'lines_y': lines_y,
        'circles': circles,
        'arcs': arcs,
        'line_count': lines_x.count(None),
        'circle_count': len(circles),
        'arc_count': len(arcs)
    }


def render_batch_to_image(geometry, bounds, output_path, dpi=150, linewidth=0.3):
    """
    Render collected geometry using batch plotting.
    This is 10-100x faster than individual plot() calls.
    """
    xmin, xmax, ymin, ymax = bounds

    # Calculate figure size maintaining aspect ratio
    span_x = xmax - xmin
    span_y = ymax - ymin
    aspect = span_x / span_y if span_y > 0 else 1

    fig_h = 40
    fig_w = fig_h * aspect
    fig_w = min(max(fig_w, 20), 80)

    fig, ax = plt.subplots(1, 1, figsize=(fig_w, fig_h))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)

    # Batch plot lines using single plot() with None separators
    if geometry['lines_x']:
        ax.plot(geometry['lines_x'], geometry['lines_y'],
                color='#000000', linewidth=linewidth, solid_capstyle='round')

    # Batch circles using PatchCollection
    if geometry['circles']:
        from matplotlib.patches import Circle
        circle_patches = [Circle((cx, cy), r, fill=False, linewidth=linewidth)
                          for cx, cy, r in geometry['circles']]
        pc = PatchCollection(circle_patches, match_original=False,
                            facecolors='none', edgecolors='#000000', linewidths=linewidth)
        ax.add_collection(pc)

    # Batch arcs
    if geometry['arcs']:
        arc_patches = [Arc((cx, cy), 2*r, 2*r, angle=0, theta1=sa, theta2=ea, linewidth=linewidth)
                       for cx, cy, r, sa, ea in geometry['arcs']]
        ac = PatchCollection(arc_patches, match_original=False,
                            facecolors='none', edgecolors='#000000', linewidths=linewidth)
        ax.add_collection(ac)

    # Save
    fig.savefig(output_path, dpi=dpi, bbox_inches='tight', facecolor='white', pad_inches=0.3)
    plt.close(fig)

    log(f"   Batch rendered: {geometry['line_count']} lines, {geometry['circle_count']} circles, {geometry['arc_count']} arcs")

    return output_path


def render_section(msp, section_bounds, y_bounds, output_path, dpi=150):
    """
    Render a single section of the DXF using batch rendering.

    Args:
        msp: Modelspace
        section_bounds: (xmin, xmax) for this section
        y_bounds: (ymin, ymax) global Y bounds
        output_path: Where to save the image
        dpi: Render DPI
    """
    xmin, xmax = section_bounds
    ymin, ymax = y_bounds

    # Add small margin
    margin = 0.02
    xpad = (xmax - xmin) * margin
    ypad = (ymax - ymin) * margin

    bounds = (xmin - xpad, xmax + xpad, ymin - ypad, ymax + ypad)

    log(f"   Rendering section X[{xmin:.0f}, {xmax:.0f}]...")

    # Collect geometry within bounds
    geometry = collect_geometry_batch(msp, bounds)

    # Render to image
    render_batch_to_image(geometry, bounds, output_path, dpi=dpi)

    return bounds


def render_dxf_sections(dxf_path, output_dir, dpi=150):
    """
    Render DXF with auto-section detection for flattened files.

    Returns:
        dict with sections data
    """
    log(f"   Using SECTION DETECTION renderer v8...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    # Count entities
    msp_list = list(msp)
    type_counts = {}
    for e in msp_list:
        t = e.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1

    total_entities = len(msp_list)
    log(f"   Modelspace: {total_entities:,} entities")
    log(f"   Types: {dict(sorted(type_counts.items(), key=lambda x: -x[1])[:8])}")

    # Collect all points
    log("   Collecting geometry points...")
    all_x, all_y = collect_all_points(msp)
    log(f"   Total points collected: {len(all_x):,}")

    if len(all_x) == 0:
        log("   ERROR: No geometry points found!")
        return None

    # Calculate global Y bounds
    ay = np.array(all_y)
    ymin = np.percentile(ay, 1)
    ymax = np.percentile(ay, 99)
    ypad = (ymax - ymin) * 0.1
    y_bounds = (ymin - ypad, ymax + ypad)

    # Detect sections
    sections = detect_sections_by_x_histogram(all_x)

    if len(sections) == 0:
        # Fall back to single full render
        log("   No sections detected, rendering full drawing...")
        ax = np.array(all_x)
        sections = [(np.percentile(ax, 1), np.percentile(ax, 99))]

    # Render each section
    section_results = []

    for i, (sec_xmin, sec_xmax) in enumerate(sections):
        section_path = os.path.join(output_dir, f'section_{i}.png')

        bounds = render_section(msp, (sec_xmin, sec_xmax), y_bounds, section_path, dpi=dpi)

        # Ensure max size
        ensure_max_size(section_path, max_dim=7000)

        section_results.append({
            'section_id': i,
            'image_path': section_path,
            'bounds': {
                'xmin': bounds[0],
                'xmax': bounds[1],
                'ymin': bounds[2],
                'ymax': bounds[3]
            },
            'classification': None  # To be filled by Claude
        })

        log(f"   Section {i}: saved to {section_path}")

    return {
        'success': True,
        'version': 'v8-sections',
        'total_entities': total_entities,
        'sections': section_results,
        'y_bounds': y_bounds,
        'entity_counts': type_counts
    }


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


def render_dxf_standard(dxf_path, output_path, dpi=150):
    """
    Standard DXF render using batch plotting for performance.
    Used for normal DXF files (not flattened).
    """
    log(f"   Using BATCH RENDER v8...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    # Count entities
    msp_list = list(msp)
    type_counts = {}
    for e in msp_list:
        t = e.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1

    log(f"   Modelspace: {len(msp_list):,} entities")
    log(f"   Types: {dict(sorted(type_counts.items(), key=lambda x: -x[1])[:8])}")

    # Collect all points
    log("   Collecting geometry points...")
    all_x, all_y = collect_all_points(msp)
    log(f"   Total points collected: {len(all_x):,}")

    if len(all_x) == 0:
        log("   ERROR: No geometry points found!")
        try:
            extmin = doc.header.get('$EXTMIN', (0, 0, 0))
            extmax = doc.header.get('$EXTMAX', (100, 100, 0))
            bounds = (float(extmin[0]), float(extmax[0]), float(extmin[1]), float(extmax[1]))
        except:
            bounds = (0, 100, 0, 100)
    else:
        bounds = calculate_smart_bounds(all_x, all_y)

    log(f"   Smart bounds: X[{bounds[0]:.1f}, {bounds[1]:.1f}] Y[{bounds[2]:.1f}, {bounds[3]:.1f}]")

    # Collect geometry in batch
    log("   Collecting geometry for batch render...")
    geometry = collect_geometry_batch(msp, bounds)

    # Render using batch method
    render_batch_to_image(geometry, bounds, output_path, dpi=dpi)

    # Check output size
    size_kb = os.path.getsize(output_path) / 1024
    log(f"   Saved: {output_path} ({size_kb:.0f}KB)")

    return output_path, bounds


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
    parser.add_argument('--sections', action='store_true', help='Force section detection mode for flattened DXF')
    parser.add_argument('--force-batch', action='store_true', help='Force batch rendering (faster for large files)')

    args = parser.parse_args()

    if not os.path.exists(args.input):
        log(f"ERROR: File not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    start = datetime.now()

    file_size_mb = os.path.getsize(args.input) / 1024 / 1024

    log('=' * 50)
    log('DXF RENDERER v8 (BATCH + SECTIONS)')
    log(f'File: {os.path.basename(args.input)} ({file_size_mb:.1f}MB)')
    log('=' * 50)

    # Step 1: Load DXF and analyze structure
    log('Loading DXF...')
    doc = read_dxf_safe(args.input)
    msp = doc.modelspace()

    # Count entities
    msp_list = list(msp)
    type_counts = {}
    for e in msp_list:
        t = e.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1

    total_entities = len(msp_list)
    layers = [layer.dxf.name for layer in doc.layers]

    # Check if flattened
    is_flattened = detect_flattened_dxf(msp, type_counts, layers)

    # Section mode for flattened files OR if --sections flag
    use_sections = args.sections or (is_flattened and total_entities > 100000)

    if use_sections:
        # === SECTION DETECTION MODE ===
        log('Using SECTION DETECTION mode for flattened DXF...')

        section_result = render_dxf_sections(args.input, args.output, dpi=args.dpi)

        if section_result is None:
            log("ERROR: Section rendering failed!")
            sys.exit(1)

        elapsed = (datetime.now() - start).total_seconds()

        result = {
            'success': True,
            'version': 'v8-sections',
            'mode': 'sections',
            'is_flattened': True,
            'total_entities': total_entities,
            'sections': section_result['sections'],
            'section_count': len(section_result['sections']),
            'entity_counts': type_counts,
            'layers': layers,
            'processing_time': elapsed
        }

        log('=' * 50)
        log(f'Complete in {elapsed:.1f}s')
        log(f'Sections rendered: {len(section_result["sections"])}')
        log(f'Total entities: {total_entities:,}')
        log('=' * 50)

    else:
        # === STANDARD HYBRID MODE ===
        log('Using STANDARD HYBRID mode...')

        # Collect points
        all_x, all_y = collect_all_points(msp)
        if len(all_x) == 0:
            log("   ERROR: No geometry points found!")
            global_bounds = (0, 100, 0, 100)
        else:
            global_bounds = calculate_smart_bounds(all_x, all_y)

        log(f"   Smart bounds: X[{global_bounds[0]:.1f}, {global_bounds[1]:.1f}] Y[{global_bounds[2]:.1f}, {global_bounds[3]:.1f}]")

        # Render
        log('Rendering DXF to high-res PNG...')
        rendered_path = os.path.join(args.output, 'rendered_plan.png')

        # Use batch rendering for large files
        if total_entities > 50000 or args.force_batch:
            log('   Using batch rendering for large entity count...')
            geometry = collect_geometry_batch(msp, global_bounds)
            render_batch_to_image(geometry, global_bounds, rendered_path, dpi=args.dpi)
        else:
            render_dxf_standard(args.input, rendered_path, dpi=args.dpi)

        # Ensure max size
        ensure_max_size(rendered_path, max_dim=7000)

        # Split into hybrid zones
        log('Splitting into hybrid analysis zones...')
        hybrid_data = split_into_hybrid_zones(
            rendered_path, args.output, msp, global_bounds,
            num_zones=10, overlap_percent=0.05
        )

        # Collect all image paths
        all_image_paths = [hybrid_data['overview']]
        for zone in hybrid_data['zones']:
            all_image_paths.append(zone['image_path'])

        # Extract metadata
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
            'version': 'v8-hybrid',
            'mode': 'hybrid',
            'is_flattened': is_flattened,
            'rendered_image': rendered_path,
            'overview': hybrid_data['overview'],
            'zones': [z['image_path'] for z in hybrid_data['zones']],
            'all_images': all_image_paths,
            'hybrid_data': hybrid_data,
            'hybrid_path': hybrid_path,
            'metadata': metadata,
            'metadata_path': metadata_path,
            'processing_time': elapsed,
            'total_entities_extracted': total_entities_extracted,
            'total_entities': total_entities
        }

        log('=' * 50)
        log(f'Complete in {elapsed:.1f}s')
        log(f'Rendered: {rendered_path}')
        log(f'Hybrid zones: {hybrid_data["total_zones"]} (with entity data)')
        log(f'Entities extracted: {total_entities_extracted} (TEXT/MTEXT/INSERT)')
        log(f'DXF entities: {metadata["total_entities"]:,} total')
        log(f'Layers: {metadata["layer_count"]}')
        log('=' * 50)

    # ONLY the JSON result goes to stdout
    if args.json:
        print(json.dumps(result, ensure_ascii=False))

    return result


if __name__ == '__main__':
    main()
