#!/usr/bin/env python3
"""
DXF Fire Safety Analyzer - Python Pipeline
Renders DXF to high-res image using ezdxf + matplotlib, then outputs for Claude Vision analysis.

v2: Fixed Hebrew text encoding (ANSI_1255 / cp1255) crash in matplotlib

Usage:
    python analyze_dxf.py input.dxf --output /tmp/output_dir
"""

import os
import sys
import json
import argparse
import tempfile
from datetime import datetime

# Try to import dependencies
try:
    import ezdxf
    from ezdxf.addons.drawing import matplotlib as mpl_drawing
    EZDXF_DRAWING = True
except ImportError:
    EZDXF_DRAWING = False
    try:
        import ezdxf
    except ImportError:
        print("ERROR: ezdxf not installed. Run: pip install ezdxf")
        sys.exit(1)

try:
    import matplotlib
    matplotlib.use('Agg')  # Headless rendering
    import matplotlib.pyplot as plt
    import matplotlib.patches as patches
except ImportError:
    print("ERROR: matplotlib not installed. Run: pip install matplotlib")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow")
    sys.exit(1)

import numpy as np


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


def safe_text(s):
    """
    Remove characters that matplotlib/FreeType can't render.
    Handles Hebrew cp1255 encoding issues and surrogate characters.
    """
    if not s:
        return ''

    cleaned = ''
    for ch in s:
        try:
            code = ord(ch)
            # Skip surrogate characters (U+D800 to U+DFFF)
            if 0xD800 <= code <= 0xDFFF:
                continue
            # Skip supplementary plane chars that FreeType may choke on
            if code > 0xFFFF:
                continue
            # Skip control characters except newline/tab
            if code < 32 and code not in (9, 10, 13):
                continue
            # Test if it's valid UTF-8
            ch.encode('utf-8')
            cleaned += ch
        except (UnicodeEncodeError, UnicodeDecodeError, ValueError):
            continue

    return cleaned


def read_dxf_safe(filepath):
    """Read DXF with proper Hebrew encoding handling."""
    # First try normal read (ezdxf handles codepage)
    try:
        doc = ezdxf.readfile(filepath)
        print(f"   Loaded DXF with default encoding")
        return doc
    except Exception as e:
        print(f"   Default read failed: {e}")

    # Try forcing cp1255 (Hebrew Windows codepage)
    try:
        doc = ezdxf.readfile(filepath, encoding='cp1255')
        print(f"   Loaded DXF with cp1255 encoding")
        return doc
    except Exception as e:
        print(f"   cp1255 read failed: {e}")

    # Try ISO-8859-8 (Hebrew ISO)
    try:
        doc = ezdxf.readfile(filepath, encoding='iso-8859-8')
        print(f"   Loaded DXF with iso-8859-8 encoding")
        return doc
    except Exception as e:
        print(f"   iso-8859-8 read failed: {e}")

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
        print(f"   Loaded DXF via transcoding workaround")
        return doc
    except Exception as e:
        print(f"   Transcoding workaround failed: {e}")

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


def render_dxf_with_addon(dxf_path, output_path, dpi=200):
    """Render DXF using ezdxf's matplotlib drawing addon."""
    print(f"   Using ezdxf drawing addon...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    entity_count = len(list(msp))
    print(f"   Loaded {entity_count} entities from modelspace")

    fig = plt.figure(figsize=(40, 40))
    ax = fig.add_axes([0, 0, 1, 1])

    ctx = mpl_drawing.RenderContext(doc)
    out = mpl_drawing.MatplotlibBackend(ax)
    mpl_drawing.Frontend(ctx, out).draw_layout(msp)

    ax.set_aspect('equal')
    ax.set_facecolor('white')
    ax.axis('off')

    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.5, format='png')
    plt.close(fig)

    print(f"   Rendered to {output_path} at {dpi} DPI")
    return output_path


def render_dxf_manual_with_text(dxf_path, output_path, dpi=200):
    """Manual rendering with sanitized text - parse entities and draw with matplotlib."""
    print(f"   Using manual renderer WITH text...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    fig, ax = plt.subplots(1, 1, figsize=(40, 40))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')

    entity_count = 0
    text_count = 0
    text_errors = 0

    # Draw LINE entities
    for entity in msp.query('LINE'):
        try:
            color = get_entity_color(entity)
            start = entity.dxf.start
            end = entity.dxf.end
            ax.plot([start.x, end.x], [start.y, end.y], color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw CIRCLE entities
    for entity in msp.query('CIRCLE'):
        try:
            color = get_entity_color(entity)
            c = entity.dxf.center
            r = entity.dxf.radius
            circle = plt.Circle((c.x, c.y), r, fill=False, color=color, linewidth=0.3)
            ax.add_patch(circle)
            entity_count += 1
        except Exception:
            pass

    # Draw ARC entities
    for entity in msp.query('ARC'):
        try:
            color = get_entity_color(entity)
            c = entity.dxf.center
            r = entity.dxf.radius
            arc = patches.Arc((c.x, c.y), 2*r, 2*r, angle=0,
                              theta1=entity.dxf.start_angle,
                              theta2=entity.dxf.end_angle,
                              color=color, linewidth=0.3)
            ax.add_patch(arc)
            entity_count += 1
        except Exception:
            pass

    # Draw LWPOLYLINE entities
    for entity in msp.query('LWPOLYLINE'):
        try:
            color = get_entity_color(entity)
            points = list(entity.get_points(format='xy'))
            if len(points) >= 2:
                xs, ys = zip(*points)
                if entity.closed:
                    xs = list(xs) + [xs[0]]
                    ys = list(ys) + [ys[0]]
                ax.plot(xs, ys, color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw POLYLINE entities
    for entity in msp.query('POLYLINE'):
        try:
            color = get_entity_color(entity)
            points = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
            if len(points) >= 2:
                xs, ys = zip(*points)
                ax.plot(xs, ys, color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw TEXT entities with sanitization
    for entity in msp.query('TEXT'):
        try:
            color = get_entity_color(entity)
            pos = entity.dxf.insert
            raw_text = entity.dxf.text
            text = safe_text(raw_text)
            if text:
                height = entity.dxf.height
                ax.text(pos.x, pos.y, text, fontsize=max(1, height * 0.5),
                        color=color, ha='left', va='bottom')
                text_count += 1
            entity_count += 1
        except Exception as e:
            text_errors += 1

    # Draw MTEXT entities with sanitization
    for entity in msp.query('MTEXT'):
        try:
            color = get_entity_color(entity)
            pos = entity.dxf.insert
            raw_text = entity.text
            text = safe_text(raw_text)
            if text:
                ax.text(pos.x, pos.y, text, fontsize=2, color=color,
                        ha='left', va='top')
                text_count += 1
            entity_count += 1
        except Exception as e:
            text_errors += 1

    # Draw POINT entities
    for entity in msp.query('POINT'):
        try:
            color = get_entity_color(entity)
            p = entity.dxf.location
            ax.plot(p.x, p.y, '.', color=color, markersize=0.5)
            entity_count += 1
        except Exception:
            pass

    # Expand and draw INSERT (block references)
    insert_count = 0
    for insert in msp.query('INSERT'):
        try:
            for entity in insert.virtual_entities():
                try:
                    color = get_entity_color(entity)
                    etype = entity.dxftype()

                    if etype == 'LINE':
                        s = entity.dxf.start
                        e = entity.dxf.end
                        ax.plot([s.x, e.x], [s.y, e.y], color=color, linewidth=0.3)
                    elif etype == 'LWPOLYLINE':
                        pts = list(entity.get_points(format='xy'))
                        if len(pts) >= 2:
                            xs, ys = zip(*pts)
                            if entity.closed:
                                xs = list(xs) + [xs[0]]
                                ys = list(ys) + [ys[0]]
                            ax.plot(xs, ys, color=color, linewidth=0.3)
                    elif etype == 'POLYLINE':
                        pts = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
                        if len(pts) >= 2:
                            xs, ys = zip(*pts)
                            ax.plot(xs, ys, color=color, linewidth=0.3)
                    elif etype == 'ARC':
                        c = entity.dxf.center
                        r = entity.dxf.radius
                        arc = patches.Arc((c.x, c.y), 2*r, 2*r, angle=0,
                                          theta1=entity.dxf.start_angle,
                                          theta2=entity.dxf.end_angle,
                                          color=color, linewidth=0.3)
                        ax.add_patch(arc)
                    elif etype == 'CIRCLE':
                        c = entity.dxf.center
                        r = entity.dxf.radius
                        ax.add_patch(plt.Circle((c.x, c.y), r, fill=False,
                                                color=color, linewidth=0.3))
                    elif etype == 'TEXT':
                        pos = entity.dxf.insert
                        text = safe_text(entity.dxf.text)
                        if text:
                            ax.text(pos.x, pos.y, text, fontsize=1, color=color)
                    elif etype == 'MTEXT':
                        pos = entity.dxf.insert
                        text = safe_text(entity.text)
                        if text:
                            ax.text(pos.x, pos.y, text, fontsize=1, color=color)

                    insert_count += 1
                except Exception:
                    pass
        except Exception:
            pass

    print(f"   Drew {entity_count} entities + {insert_count} from block references")
    print(f"   Text rendered: {text_count}, text errors: {text_errors}")

    ax.autoscale()
    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.5, format='png')
    plt.close(fig)

    print(f"   Rendered to {output_path}")
    return output_path


def render_dxf_no_text(dxf_path, output_path, dpi=200):
    """Manual rendering WITHOUT text - skips TEXT/MTEXT to avoid encoding crashes."""
    print(f"   Using manual renderer WITHOUT text (geometry only)...")

    doc = read_dxf_safe(dxf_path)
    msp = doc.modelspace()

    fig, ax = plt.subplots(1, 1, figsize=(40, 40))
    ax.set_facecolor('white')
    ax.set_aspect('equal')
    ax.axis('off')

    entity_count = 0

    # Draw LINE entities
    for entity in msp.query('LINE'):
        try:
            color = get_entity_color(entity)
            start = entity.dxf.start
            end = entity.dxf.end
            ax.plot([start.x, end.x], [start.y, end.y], color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw CIRCLE entities
    for entity in msp.query('CIRCLE'):
        try:
            color = get_entity_color(entity)
            c = entity.dxf.center
            r = entity.dxf.radius
            circle = plt.Circle((c.x, c.y), r, fill=False, color=color, linewidth=0.3)
            ax.add_patch(circle)
            entity_count += 1
        except Exception:
            pass

    # Draw ARC entities
    for entity in msp.query('ARC'):
        try:
            color = get_entity_color(entity)
            c = entity.dxf.center
            r = entity.dxf.radius
            arc = patches.Arc((c.x, c.y), 2*r, 2*r, angle=0,
                              theta1=entity.dxf.start_angle,
                              theta2=entity.dxf.end_angle,
                              color=color, linewidth=0.3)
            ax.add_patch(arc)
            entity_count += 1
        except Exception:
            pass

    # Draw LWPOLYLINE entities
    for entity in msp.query('LWPOLYLINE'):
        try:
            color = get_entity_color(entity)
            points = list(entity.get_points(format='xy'))
            if len(points) >= 2:
                xs, ys = zip(*points)
                if entity.closed:
                    xs = list(xs) + [xs[0]]
                    ys = list(ys) + [ys[0]]
                ax.plot(xs, ys, color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw POLYLINE entities
    for entity in msp.query('POLYLINE'):
        try:
            color = get_entity_color(entity)
            points = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
            if len(points) >= 2:
                xs, ys = zip(*points)
                ax.plot(xs, ys, color=color, linewidth=0.3)
            entity_count += 1
        except Exception:
            pass

    # Draw POINT entities
    for entity in msp.query('POINT'):
        try:
            color = get_entity_color(entity)
            p = entity.dxf.location
            ax.plot(p.x, p.y, '.', color=color, markersize=0.5)
            entity_count += 1
        except Exception:
            pass

    # Expand and draw INSERT (block references) - GEOMETRY ONLY
    insert_count = 0
    for insert in msp.query('INSERT'):
        try:
            for entity in insert.virtual_entities():
                try:
                    color = get_entity_color(entity)
                    etype = entity.dxftype()

                    if etype == 'LINE':
                        s = entity.dxf.start
                        e = entity.dxf.end
                        ax.plot([s.x, e.x], [s.y, e.y], color=color, linewidth=0.3)
                        insert_count += 1
                    elif etype == 'LWPOLYLINE':
                        pts = list(entity.get_points(format='xy'))
                        if len(pts) >= 2:
                            xs, ys = zip(*pts)
                            if entity.closed:
                                xs = list(xs) + [xs[0]]
                                ys = list(ys) + [ys[0]]
                            ax.plot(xs, ys, color=color, linewidth=0.3)
                        insert_count += 1
                    elif etype == 'POLYLINE':
                        pts = [(v.dxf.location.x, v.dxf.location.y) for v in entity.vertices]
                        if len(pts) >= 2:
                            xs, ys = zip(*pts)
                            ax.plot(xs, ys, color=color, linewidth=0.3)
                        insert_count += 1
                    elif etype == 'ARC':
                        c = entity.dxf.center
                        r = entity.dxf.radius
                        arc = patches.Arc((c.x, c.y), 2*r, 2*r, angle=0,
                                          theta1=entity.dxf.start_angle,
                                          theta2=entity.dxf.end_angle,
                                          color=color, linewidth=0.3)
                        ax.add_patch(arc)
                        insert_count += 1
                    elif etype == 'CIRCLE':
                        c = entity.dxf.center
                        r = entity.dxf.radius
                        ax.add_patch(plt.Circle((c.x, c.y), r, fill=False,
                                                color=color, linewidth=0.3))
                        insert_count += 1
                    # Skip TEXT and MTEXT inside blocks
                except Exception:
                    pass
        except Exception:
            pass

    print(f"   Drew {entity_count} entities + {insert_count} from block references (no text)")

    ax.autoscale()
    fig.savefig(output_path, dpi=dpi, bbox_inches='tight',
                facecolor='white', pad_inches=0.5, format='png')
    plt.close(fig)

    print(f"   Rendered to {output_path}")
    return output_path


def render_dxf(dxf_path, output_path, dpi=200):
    """
    Render DXF to PNG with multiple fallback strategies:
    1. Try ezdxf addon (best quality)
    2. Try manual renderer with sanitized text
    3. Try manual renderer without text (most robust)
    """
    # Strategy 1: ezdxf drawing addon
    if EZDXF_DRAWING:
        try:
            return render_dxf_with_addon(dxf_path, output_path, dpi)
        except Exception as e:
            print(f"   Addon failed: {e}")

    # Strategy 2: Manual renderer with sanitized text
    try:
        return render_dxf_manual_with_text(dxf_path, output_path, dpi)
    except Exception as e:
        print(f"   Manual renderer with text failed: {e}")

    # Strategy 3: Manual renderer without text (most robust)
    print(f"   Falling back to geometry-only renderer...")
    return render_dxf_no_text(dxf_path, output_path, dpi)


def split_into_zones(image_path, output_dir, grid=(3, 3)):
    """Split rendered image into zones + create overview."""
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(image_path)
    w, h = img.size

    print(f"   Image size: {w}x{h}")

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

    print(f"   Created {len(paths)} images (1 overview + {rows*cols} zones)")
    return paths


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

    # All text content (sanitized)
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
        print(f"ERROR: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    start = datetime.now()

    if not args.json:
        print('=' * 50)
        print('🎨 DXF RENDERER v2 (Hebrew-safe)')
        print(f'📁 {os.path.basename(args.input)} ({os.path.getsize(args.input) / 1024 / 1024:.1f}MB)')
        print('=' * 50)

    # Step 1: Render DXF to PNG
    if not args.json:
        print('🎨 Rendering DXF to high-res PNG...')
    rendered_path = os.path.join(args.output, 'rendered_plan.png')
    render_dxf(args.input, rendered_path, dpi=args.dpi)

    # Step 2: Split into zones
    if not args.json:
        print('🔍 Splitting into analysis zones...')
    image_paths = split_into_zones(rendered_path, args.output)

    # Step 3: Extract metadata
    if not args.json:
        print('📊 Extracting DXF metadata...')
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

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print('=' * 50)
        print(f'✅ Complete in {elapsed:.1f}s')
        print(f'🖼️  Rendered: {rendered_path}')
        print(f'📊 Entities: {metadata["total_entities"]}')
        print(f'📄 Layers: {metadata["layer_count"]}')
        print(f'📝 Texts: {metadata["text_count"]}')
        print('=' * 50)

    return result


if __name__ == '__main__':
    main()
