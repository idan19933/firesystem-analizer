#!/usr/bin/env python3
"""
DXF Fire Safety Analyzer - Python Pipeline
Renders DXF to high-res image using ezdxf + matplotlib, then outputs for Claude Vision analysis.

v5: PROVEN RENDERER - Fixed block expansion, color visibility, bounds calculation
    - Blocks expand with entity.virtual_entities()
    - Color 7/0 forced to black (not white-on-white)
    - ax.autoscale_view() for proper bounds
    - Debug logging for block expansion

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


def render_dxf(dxf_path, output_path, dpi=150):
    """
    Render DXF to PNG - PROVEN approach with proper block expansion.
    - Skips all text (Hebrew encoding issues)
    - Forces color 7/0 to black (visible on white)
    - Uses autoscale_view for proper bounds
    """
    log(f"   Using PROVEN renderer v5...")

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

    fig, ax = plt.subplots(1, 1, figsize=(40, 30))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')

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

                # Debug: log first 5 INSERTs
                if insert_count <= 5:
                    log(f"   INSERT #{insert_count} '{entity.dxf.name}': {len(ves)} virtual entities")

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
                if insert_count <= 5:
                    log(f"   Block expand error on '{entity.dxf.name}': {ex}")

    pass2_drawn = drawn - pass1_drawn
    log(f"   Pass 2 (blocks): {insert_count} INSERTs, {blocks_with_content} had content, {pass2_drawn} entities drawn")
    log(f"   TOTAL: {drawn} entities drawn, {skipped_text} text skipped")

    # Let matplotlib auto-calculate bounds from drawn data
    ax.autoscale_view()

    # Verify bounds aren't degenerate
    xlim = ax.get_xlim()
    ylim = ax.get_ylim()
    log(f"   Bounds: X[{xlim[0]:.1f}, {xlim[1]:.1f}] Y[{ylim[0]:.1f}, {ylim[1]:.1f}]")

    if xlim[0] == xlim[1] or ylim[0] == ylim[1]:
        log("   ERROR: Degenerate bounds — nothing visible!")

    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.5)
    plt.close(fig)

    # Check output size
    size_kb = os.path.getsize(output_path) / 1024
    log(f"   Saved: {output_path} ({size_kb:.0f}KB)")

    if size_kb < 50:
        log("   WARNING: Image very small — likely blank!")

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
    log('DXF RENDERER v5 (PROVEN - block expansion fixed)')
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
