#!/usr/bin/env python3
"""
DXF Fire Safety Analyzer - Python Pipeline
Renders DXF to high-res image using ezdxf + matplotlib, then outputs for Claude Vision analysis.

v4: GEOMETRY ONLY - Skip ALL text rendering (Hebrew causes garbled output)
    Full block expansion for complete floor plan rendering

Usage:
    python analyze_dxf.py input.dxf --output /tmp/output_dir --json
"""

import os
import sys
import json
import argparse
import tempfile
from datetime import datetime


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
    import matplotlib.patches as patches
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


# ACI color map (AutoCAD Color Index)
ACI_COLORS = {
    0: '#000000',   # ByBlock
    1: '#FF0000',   # Red
    2: '#FFFF00',   # Yellow
    3: '#00FF00',   # Green
    4: '#00FFFF',   # Cyan
    5: '#0000FF',   # Blue
    6: '#FF00FF',   # Magenta
    7: '#000000',   # White/Black (depends on background)
    8: '#808080',   # Dark Gray
    9: '#C0C0C0',   # Light Gray
    10: '#FF0000', 11: '#FF7F7F', 12: '#CC0000', 13: '#CC6666', 14: '#990000',
    15: '#996666', 16: '#7F0000', 17: '#7F4C4C', 18: '#4C0000', 19: '#4C2626',
    250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#BEBEBE', 255: '#FFFFFF'
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

        # Try to decode as cp1255 and re-encode as utf-8
        text = raw.decode('cp1255', errors='replace')
        # Replace the codepage declaration if present
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


def get_entity_color(entity):
    """Get color from entity, handling ByLayer and ByBlock."""
    try:
        color = entity.dxf.color
        if color == 256:  # ByLayer
            return '#000000'
        elif color == 0:  # ByBlock
            return '#000000'
        return ACI_COLORS.get(color, '#000000')
    except:
        return '#000000'


def draw_entity(ax, entity, drawn_counter):
    """
    Draw a single entity to the axes. Returns number of entities drawn (0 or 1).
    Skips TEXT and MTEXT - Hebrew encoding creates garbled output.
    """
    etype = entity.dxftype()

    # Skip ALL text entities - Hebrew encoding causes garbled escape sequences
    if etype in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'):
        return 0

    try:
        color = get_entity_color(entity)

        if etype == 'LINE':
            s = entity.dxf.start
            e = entity.dxf.end
            ax.plot([s.x, e.x], [s.y, e.y], color=color, linewidth=0.3)
            return 1

        elif etype == 'LWPOLYLINE':
            pts = list(entity.get_points(format='xy'))
            if len(pts) >= 2:
                xs, ys = zip(*pts)
                if entity.closed:
                    xs = list(xs) + [xs[0]]
                    ys = list(ys) + [ys[0]]
                ax.plot(xs, ys, color=color, linewidth=0.3)
                return 1

        elif etype == 'POLYLINE':
            try:
                pts = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
                if len(pts) >= 2:
                    xs, ys = zip(*pts)
                    ax.plot(xs, ys, color=color, linewidth=0.3)
                    return 1
            except:
                pass

        elif etype == 'ARC':
            c = entity.dxf.center
            r = entity.dxf.radius
            arc = patches.Arc((c.x, c.y), 2*r, 2*r, angle=0,
                              theta1=entity.dxf.start_angle,
                              theta2=entity.dxf.end_angle,
                              color=color, linewidth=0.3)
            ax.add_patch(arc)
            return 1

        elif etype == 'CIRCLE':
            c = entity.dxf.center
            r = entity.dxf.radius
            ax.add_patch(plt.Circle((c.x, c.y), r, fill=False,
                                    color=color, linewidth=0.3))
            return 1

        elif etype == 'POINT':
            p = entity.dxf.location
            ax.plot(p.x, p.y, '.', color=color, markersize=0.5)
            return 1

        elif etype == 'ELLIPSE':
            try:
                c = entity.dxf.center
                # Ellipse major axis is relative to center
                major = entity.dxf.major_axis
                ratio = entity.dxf.ratio
                # Calculate dimensions
                a = (major.x**2 + major.y**2)**0.5  # semi-major axis length
                b = a * ratio  # semi-minor axis length
                # Calculate rotation angle
                import math
                angle = math.degrees(math.atan2(major.y, major.x))
                ellipse = patches.Ellipse((c.x, c.y), 2*a, 2*b, angle=angle,
                                          fill=False, color=color, linewidth=0.3)
                ax.add_patch(ellipse)
                return 1
            except:
                pass

        elif etype == 'SPLINE':
            try:
                # Get control points for approximation
                pts = list(entity.control_points)
                if len(pts) >= 2:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    ax.plot(xs, ys, color=color, linewidth=0.3)
                    return 1
            except:
                pass

        elif etype == 'HATCH':
            try:
                # Draw hatch boundary paths
                for path in entity.paths:
                    try:
                        if hasattr(path, 'vertices'):
                            pts = [(v[0], v[1]) for v in path.vertices]
                            if len(pts) >= 2:
                                xs, ys = zip(*pts)
                                ax.plot(list(xs) + [xs[0]], list(ys) + [ys[0]],
                                       color=color, linewidth=0.2)
                    except:
                        pass
                return 1
            except:
                pass

        elif etype == 'SOLID':
            try:
                # 2D solid (filled triangle or quad)
                pts = [entity.dxf.vtx0, entity.dxf.vtx1, entity.dxf.vtx2]
                if hasattr(entity.dxf, 'vtx3'):
                    pts.append(entity.dxf.vtx3)
                xs = [p.x for p in pts] + [pts[0].x]
                ys = [p.y for p in pts] + [pts[0].y]
                ax.fill(xs, ys, color=color, alpha=0.3, linewidth=0.2)
                return 1
            except:
                pass

    except Exception:
        pass

    return 0


def render_dxf(dxf_path, output_path, dpi=200):
    """
    Render DXF to PNG - GEOMETRY ONLY, no text.
    Fully expands all INSERT (block references) for complete rendering.
    """
    log(f"   Using geometry-only renderer (v4 - no text, full block expansion)...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    # Count entities in modelspace
    msp_entities = list(msp)
    total_msp = len(msp_entities)

    # Count by type
    type_counts = {}
    for e in msp_entities:
        t = e.dxftype()
        type_counts[t] = type_counts.get(t, 0) + 1

    log(f"   Modelspace entities: {total_msp}")
    log(f"   Entity types: {dict(sorted(type_counts.items(), key=lambda x: -x[1])[:10])}")

    fig, ax = plt.subplots(1, 1, figsize=(40, 40))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')

    drawn_direct = 0
    drawn_from_blocks = 0
    skipped_text = 0

    # Pass 1: Draw all direct entities (except INSERTs)
    for entity in msp_entities:
        etype = entity.dxftype()

        # Skip text entities
        if etype in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'):
            skipped_text += 1
            continue

        # Skip INSERTs in this pass - we'll expand them
        if etype == 'INSERT':
            continue

        drawn_direct += draw_entity(ax, entity, drawn_direct)

    log(f"   Drew {drawn_direct} direct entities (skipped {skipped_text} text)")

    # Pass 2: Expand and draw all INSERT (block references)
    insert_count = type_counts.get('INSERT', 0)
    log(f"   Expanding {insert_count} block references...")

    for entity in msp_entities:
        if entity.dxftype() != 'INSERT':
            continue

        try:
            # virtual_entities() explodes the block reference
            for ve in entity.virtual_entities():
                vetype = ve.dxftype()

                # Skip text in blocks too
                if vetype in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF'):
                    skipped_text += 1
                    continue

                # Recursively handle nested INSERTs
                if vetype == 'INSERT':
                    try:
                        for nested_ve in ve.virtual_entities():
                            if nested_ve.dxftype() not in ('TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'INSERT'):
                                drawn_from_blocks += draw_entity(ax, nested_ve, drawn_from_blocks)
                    except:
                        pass
                    continue

                drawn_from_blocks += draw_entity(ax, ve, drawn_from_blocks)

        except Exception as e:
            # Some blocks may fail to explode
            pass

    total_drawn = drawn_direct + drawn_from_blocks
    log(f"   Drew {drawn_from_blocks} entities from block expansion")
    log(f"   TOTAL DRAWN: {total_drawn} entities (skipped {skipped_text} text)")

    ax.autoscale()
    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.5, format='png')
    plt.close(fig)

    log(f"   Rendered to {output_path} at {dpi} DPI")
    return output_path


def split_into_zones(image_path, output_dir, grid=(3, 3)):
    """Split rendered image into zones + create overview."""
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

    # All text content (sanitized) - for metadata only, not rendering
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

    # Fire-related keywords search
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
    parser.add_argument('--dpi', type=int, default=200, help='Render DPI (default: 200)')
    parser.add_argument('--json', action='store_true', help='Output results as JSON to stdout')

    args = parser.parse_args()

    if not os.path.exists(args.input):
        log(f"ERROR: File not found: {args.input}")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    start = datetime.now()

    # All progress logging goes to stderr
    log('=' * 50)
    log('DXF RENDERER v4 (GEOMETRY ONLY - no text)')
    log(f'File: {os.path.basename(args.input)} ({os.path.getsize(args.input) / 1024 / 1024:.1f}MB)')
    log('=' * 50)

    # Step 1: Render DXF to PNG
    log('Rendering DXF to high-res PNG...')
    rendered_path = os.path.join(args.output, 'rendered_plan.png')
    render_dxf(args.input, rendered_path, dpi=args.dpi)

    # Step 1.5: Ensure image doesn't exceed Claude's 8000px limit
    ensure_max_size(rendered_path, max_dim=7000)

    # Step 2: Split into zones
    log('Splitting into analysis zones...')
    image_paths = split_into_zones(rendered_path, args.output)

    # Step 3: Extract metadata
    log('Extracting DXF metadata...')
    metadata = extract_metadata(args.input)

    # Save metadata
    metadata_path = os.path.join(args.output, 'metadata.json')
    with open(metadata_path, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    elapsed = (datetime.now() - start).total_seconds()

    result = {
        'success': True,
        'rendered_image': rendered_path,
        'overview': image_paths[0],
        'zones': image_paths[1:],
        'all_images': image_paths,
        'metadata': metadata,
        'metadata_path': metadata_path,
        'processing_time': elapsed
    }

    # Summary to stderr
    log('=' * 50)
    log(f'Complete in {elapsed:.1f}s')
    log(f'Rendered: {rendered_path}')
    log(f'Entities in file: {metadata["total_entities"]}')
    log(f'Layers: {metadata["layer_count"]}')
    log('=' * 50)

    # ONLY the JSON result goes to stdout
    if args.json:
        print(json.dumps(result, ensure_ascii=False))

    return result


if __name__ == '__main__':
    main()
