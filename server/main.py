from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import fitz
import re
import base64
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}

# ------------------------------------------------------------------ #
#  Font name normalizer                                               #
#  PDF internal names → CSS font-family stack                        #
# ------------------------------------------------------------------ #

SERIF_KEYWORDS = [
    "times", "timesnewroman", "timesroman", "georgia", "garamond",
    "palatino", "bookman", "centuryschoolbook", "nimbusromno9l",
    "minion", "constantia", "cambria", "didot", "caslon", "baskerville",
    "bodoni", "rockwell", "charter", "utopia", "goudyoldsty",
    "lucidabright", "merriweather", "playfair", "ptserif", "roboto-slab",
    "lora", "bree", "slab", "arvo", "bitstreamvera", "hoefler",
    "benguiat", "plantin", "sabong", "sylfaen", "bellmt", "californian",
    "elephant", "perpetua", "lucidafax"
]

MONO_KEYWORDS = [
    "courier", "couriernew", "courier10pitch", "lucidatypewriter",
    "consolasconsolas", "inconsolata", "dejavusansmono", "droidsansmono",
    "liberationmono", "nimbusmonol", "anonymouspro", "sourcecodepro",
    "spacemono", "mono", "typewriter", "consolas", "menlo", "monaco",
    "firamono", "ubuntumono", "bitstreamverasansmono", "oxygenmono",
    "jetbrainsmono", "cascadiacode", "cascadiamono", "andale", "lucidaconsole"
]

SANS_KEYWORDS = [
    "arial", "helvetica", "calibri", "verdana", "tahoma", "trebuchet",
    "futura", "gill", "optima", "myriad", "nimbussanl", "freesans",
    "liberationsans", "dejavusans", "opensans", "roboto", "lato",
    "sourcesanspro", "notosans", "ubuntu", "frutiger", "univers",
    "franklin", "gothic", "sans", "lucidasans", "segoe", "corbel",
    "candara", "montserrat", "raleway", "poppins", "oswald", "ptsans",
    "droidsans", "applesdgothic", "inter", "nunito", "quicksand",
    "work-sans", "firasans", "rubik", "karla", "heebo", "hind"
]

def normalize_font_name(raw_name: str) -> dict:
    """
    Given a raw PDF font name like 'ABCDEF+ArialMT' or 'NimbusSanL-Regu',
    return { cssFamily, genericFamily, fontWeight, fontStyle }.
    
    We also extract bold/italic from the name itself because PyMuPDF's
    flags field is unreliable for fonts that encode style in the name
    rather than the font descriptor (common in Word-exported PDFs).
    """
    if not raw_name:
        return {
            "cssFamily": '"Helvetica Neue", Arial, sans-serif',
            "genericFamily": "sans-serif",
            "fontWeight": "normal",
            "fontStyle": "normal",
        }

    # 1. Strip subset prefix like "ABCDEF+"
    name = re.sub(r'^[A-Z]{6}\+', '', raw_name)

    # 2. Normalize: lowercase, remove separators for keyword matching
    normalized = name.lower()
    normalized_stripped = re.sub(r'[\s\-_,.]', '', normalized)

    # 3. Detect bold / italic from the name
    #    Check BEFORE stripping these words for family detection
    is_bold   = bool(re.search(r'\b(bold|black|heavy|semibold|demi|extrabold|ultrabold|medium)\b', normalized) or
                     re.search(r'(bold|black|heavy|semibold|demi)', normalized_stripped))
    is_italic = bool(re.search(r'\b(italic|oblique|slanted|it)\b', normalized) or
                     normalized_stripped.endswith('it') or
                     normalized_stripped.endswith('italic') or
                     normalized_stripped.endswith('oblique'))

    font_weight = "bold"   if is_bold   else "normal"
    font_style  = "italic" if is_italic else "normal"

    # 4. Detect generic family
    generic = "sans-serif"  # safe default

    for kw in MONO_KEYWORDS:
        if kw in normalized_stripped:
            generic = "monospace"
            break

    if generic == "sans-serif":
        for kw in SERIF_KEYWORDS:
            if kw in normalized_stripped:
                generic = "serif"
                break

    # SANS checked last — many serif names don't contain "sans",
    # but if we already identified serif/mono, don't override
    if generic == "sans-serif":
        for kw in SANS_KEYWORDS:
            if kw in normalized_stripped:
                generic = "sans-serif"
                break

    # 5. Build a CSS font-family stack
    #    Try to map to a known web-safe / Google Fonts equivalent
    #    so the rendered overlay is as close as possible visually.
    css_family = _build_css_stack(normalized_stripped, name, generic)

    return {
        "cssFamily":      css_family,
        "genericFamily":  generic,
        "fontWeight":     font_weight,
        "fontStyle":      font_style,
    }


def _build_css_stack(ns: str, original: str, generic: str) -> str:
    """Map normalized name → best CSS font stack."""

    # --- Monospace ---
    if generic == "monospace":
        if "courier" in ns:
            return '"Courier New", Courier, monospace'
        return '"Courier New", "Lucida Console", monospace'

    # --- Serif ---
    if generic == "serif":
        if "times" in ns or "nimburom" in ns or "nimbusromno" in ns:
            return '"Times New Roman", Times, serif'
        if "georgia" in ns:
            return 'Georgia, serif'
        if "garamond" in ns:
            return 'Garamond, "EB Garamond", serif'
        if "palatino" in ns:
            return '"Palatino Linotype", Palatino, serif'
        if "bookman" in ns:
            return '"Bookman Old Style", serif'
        if "cambria" in ns:
            return 'Cambria, "Times New Roman", serif'
        if "constantia" in ns:
            return 'Constantia, serif'
        if "baskerville" in ns:
            return 'Baskerville, "Baskerville Old Face", "Hoefler Text", serif'
        if "caslon" in ns:
            return '"Adobe Caslon Pro", "Big Caslon", serif'
        if "minion" in ns:
            return '"Minion Pro", serif'
        if "merriweather" in ns:
            return 'Merriweather, serif'
        if "playfair" in ns:
            return '"Playfair Display", serif'
        if "lora" in ns:
            return 'Lora, serif'
        if "lucidabright" in ns or "lucidafax" in ns:
            return '"Lucida Bright", "Lucida Fax", serif'
        if "perpetua" in ns:
            return 'Perpetua, serif'
        return '"Times New Roman", Times, serif'

    # --- Sans-serif ---
    if "arial" in ns or "arialmt" in ns:
        return 'Arial, "Helvetica Neue", sans-serif'
    if "helvetica" in ns or "nimbusanl" in ns or "nimbussanl" in ns:
        return '"Helvetica Neue", Helvetica, Arial, sans-serif'
    if "calibri" in ns:
        return 'Calibri, "Gill Sans", sans-serif'
    if "verdana" in ns:
        return 'Verdana, Geneva, sans-serif'
    if "tahoma" in ns:
        return 'Tahoma, Verdana, sans-serif'
    if "trebuchet" in ns:
        return '"Trebuchet MS", sans-serif'
    if "gill" in ns:
        return '"Gill Sans", "Gill Sans MT", sans-serif'
    if "futura" in ns:
        return 'Futura, "Century Gothic", sans-serif'
    if "centurygothic" in ns:
        return '"Century Gothic", sans-serif'
    if "optima" in ns:
        return 'Optima, sans-serif'
    if "franklin" in ns or "franklingothic" in ns:
        return '"Franklin Gothic Medium", sans-serif'
    if "myriad" in ns:
        return '"Myriad Pro", sans-serif'
    if "segoeui" in ns or "segoe" in ns:
        return '"Segoe UI", Tahoma, Geneva, sans-serif'
    if "opensans" in ns:
        return '"Open Sans", sans-serif'
    if "roboto" in ns:
        return 'Roboto, "Helvetica Neue", Arial, sans-serif'
    if "lato" in ns:
        return 'Lato, sans-serif'
    if "sourcesans" in ns:
        return '"Source Sans Pro", "Source Sans 3", sans-serif'
    if "notosans" in ns:
        return '"Noto Sans", sans-serif'
    if "liberationsans" in ns or "liberarion" in ns:
        return '"Liberation Sans", Arial, sans-serif'
    if "dejavusans" in ns:
        return '"DejaVu Sans", Arial, sans-serif'
    if "frutiger" in ns:
        return 'Frutiger, "Frutiger Linotype", Univers, sans-serif'
    if "univers" in ns:
        return 'Univers, "Zurich BT", sans-serif'
    if "montserrat" in ns:
        return 'Montserrat, sans-serif'
    if "poppins" in ns:
        return 'Poppins, sans-serif'
    if "inter" in ns:
        return 'Inter, -apple-system, sans-serif'
    if "lucidasans" in ns:
        return '"Lucida Sans", "Lucida Grande", sans-serif'
    if "corbel" in ns:
        return 'Corbel, sans-serif'
    if "candara" in ns:
        return 'Candara, sans-serif'

    # Fallback
    return '"Helvetica Neue", Arial, sans-serif'

def extract_embedded_fonts(doc) -> dict:
    font_map = {}
    for page_index in range(len(doc)):
        page = doc[page_index]
        for font in page.get_fonts(full=True):
            xref     = font[0]
            ext      = font[1]
            basefont = font[3]
            if xref == 0 or basefont in font_map:
                continue
            try:
                font_data = doc.extract_font(xref)
                # PyMuPDF doc.extract_font(xref) returns (basename, ext, type, content) -> content is index 3
                raw_bytes = font_data[3] if font_data and len(font_data) >= 4 else None
                if raw_bytes:
                    mime = "font/otf" if ext == "otf" else "font/truetype"
                    b64  = base64.b64encode(raw_bytes).decode("utf-8")
                    font_map[basefont] = f"data:{mime};base64,{b64}"
            except Exception:
                pass
    return font_map

# ------------------------------------------------------------------ #
#  Endpoint                                                           #
# ------------------------------------------------------------------ #

@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    try:
        content = await file.read()
        doc = fitz.open(stream=content, filetype="pdf")

        if doc.is_encrypted:
            raise HTTPException(status_code=400, detail="PDF is encrypted")

        result = {"pages": {}}

        for page_index in range(len(doc)):
            page = doc[page_index]
            page_width  = page.rect.width
            page_height = page.rect.height

            blocks = page.get_text(
                "dict",
                flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_PRESERVE_LIGATURES
            )["blocks"]

            spans_list = []

            for block in blocks:
                if "lines" not in block:
                    continue
                for line in block["lines"]:
                    for span in line["spans"]:
                        text = span.get("text", "")
                        if not text.strip():
                            continue

                        bbox        = span["bbox"]
                        color_int   = span.get("color", 0)
                        raw_font    = span.get("font", "")
                        flags       = span.get("flags", 0)

                        font_info   = normalize_font_name(raw_font)

                        # Flags from PyMuPDF can be unreliable for style —
                        # use the name-derived values as primary, flags as
                        # fallback only when name gives nothing useful.
                        font_weight = font_info["fontWeight"]
                        font_style  = font_info["fontStyle"]

                        # But if flags explicitly say bold/italic AND name
                        # didn't catch it, trust the flags too
                        if flags & 16 and font_weight == "normal":
                            font_weight = "bold"
                        if flags & 2 and font_style == "normal":
                            font_style = "italic"

                        stripped = re.sub(r'^[A-Z]{6}\+', '', raw_font)
                        css_family = f'"{stripped}", {font_info["cssFamily"]}'

                        spans_list.append({
                            "page":        page_index + 1,
                            "str":         text,
                            "x":           bbox[0],
                            "y":           bbox[1],
                            "width":       bbox[2] - bbox[0],
                            "height":      bbox[3] - bbox[1],
                            "fontSize":    span.get("size", 12),
                            "fontName":    raw_font,        # raw, for debugging
                            "fontFamily":  css_family,   # use this in CSS
                            "genericFamily": font_info["genericFamily"],
                            "fontWeight":  font_weight,
                            "fontStyle":   font_style,
                            "color":       f'#{color_int:06x}',
                            "pageWidth":   page_width,
                            "pageHeight":  page_height,
                        })

            result["pages"][str(page_index + 1)] = spans_list

        result["embeddedFonts"] = extract_embedded_fonts(doc)
        doc.close()
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def hex_to_rgb(hex_color: str):
    if not hex_color or not isinstance(hex_color, str):
        return (0, 0, 0)
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        try:
            return tuple(int(hex_color[i:i+2], 16)/255.0 for i in (0, 2, 4))
        except:
            pass
    return (0, 0, 0)

@app.post("/export")
async def export_pdf(
    file: UploadFile = File(...),
    annotations: str = Form(...),
    textEdits: str = Form(...),
    scale: float = Form(...)
):
    try:
        content = await file.read()
        doc = fitz.open(stream=content, filetype="pdf")

        anns = json.loads(annotations)
        edits = json.loads(textEdits)

        for ann in anns:
            page_num = int(ann.get("page", 1)) - 1
            if page_num < 0 or page_num >= len(doc):
                continue
            page = doc[page_num]

            if ann["type"] == "highlight":
                rect = fitz.Rect(
                    ann["x"] / scale,
                    ann["y"] / scale,
                    (ann["x"] + ann["width"]) / scale,
                    (ann["y"] + ann["height"]) / scale
                )
                annot = page.add_highlight_annot(rect)
                rgb = hex_to_rgb(ann.get("color", "#fbbf24"))
                annot.set_colors(stroke=rgb)
                annot.set_opacity(ann.get("opacity", 0.3))
                annot.update()

            elif ann["type"] == "ink":
                path = ann.get("path", [])
                if not path or len(path) < 2:
                    continue
                pts = [[(p["x"] / scale, p["y"] / scale) for p in path]]
                annot = page.add_ink_annot(pts)
                rgb = hex_to_rgb(ann.get("fontColor", "#818cf8"))
                annot.set_colors(stroke=rgb)
                annot.set_border(width=2.5 / scale)
                annot.update()

            elif ann["type"] == "text":
                text = ann.get("text", "")
                if not text.strip():
                    continue
                font_size = ann.get("fontSize", 14)
                rgb = hex_to_rgb(ann.get("fontColor", "#000000"))
                # Generous rect to ensure it fits without wrapping early
                rect = fitz.Rect(
                    ann["x"] / scale,
                    ann["y"] / scale,
                    (ann["x"] + ann.get("width", 200)) / scale + 500,
                    (ann["y"] + ann.get("height", 50)) / scale + 500
                )
                try:
                    page.insert_textbox(rect, text, fontname="helv", fontsize=font_size, color=rgb, align=0)
                except Exception as ex:
                    safe_text = text.encode("ascii", "ignore").decode("ascii")
                    page.insert_textbox(rect, safe_text, fontname="helv", fontsize=font_size, color=rgb, align=0)

            elif ann["type"] in ["rect", "ellipse"]:
                rect = fitz.Rect(
                    ann["x"] / scale,
                    ann["y"] / scale,
                    (ann["x"] + ann["width"]) / scale,
                    (ann["y"] + ann["height"]) / scale
                )
                stroke_rgb = hex_to_rgb(ann.get("strokeColor", "#000000"))
                fill_color = ann.get("fillColor", "transparent")
                fill_rgb = hex_to_rgb(fill_color) if fill_color and fill_color != "transparent" else None
                width = ann.get("strokeWidth", 2) / scale
                
                if ann["type"] == "rect":
                    annot = page.add_rect_annot(rect)
                else:
                    annot = page.add_circle_annot(rect)
                
                annot.set_colors(stroke=stroke_rgb, fill=fill_rgb)
                annot.set_border(width=width)
                annot.update()

            elif ann["type"] == "line":
                p1 = fitz.Point(ann["x"] / scale, ann["y"] / scale)
                p2 = fitz.Point(ann.get("x2", ann["x"]) / scale, ann.get("y2", ann["y"]) / scale)
                stroke_rgb = hex_to_rgb(ann.get("strokeColor", "#000000"))
                width = ann.get("strokeWidth", 2) / scale
                
                annot = page.add_line_annot(p1, p2)
                annot.set_colors(stroke=stroke_rgb)
                annot.set_border(width=width)
                annot.update()

        edits_by_page = {}
        for edit in edits:
            page_num = int(edit.get("page", 1)) - 1
            if page_num < 0 or page_num >= len(doc):
                continue
            if page_num not in edits_by_page:
                edits_by_page[page_num] = []
            edits_by_page[page_num].append(edit)

        for page_num, page_edits in edits_by_page.items():
            page = doc[page_num]

            # Step 1: Redact original text bounds (removes text without drawing a white box)
            has_redactions = False
            for edit in page_edits:
                bounds = edit.get("bounds")
                orig_bounds = edit.get("originalBounds") or bounds
                if orig_bounds and edit.get("itemIndex", -1) >= 0:
                    rect = fitz.Rect(
                        orig_bounds["x"] / scale,
                        orig_bounds["y"] / scale,
                        (orig_bounds["x"] + orig_bounds["w"]) / scale,
                        (orig_bounds["y"] + orig_bounds["h"]) / scale
                    )
                    page.add_redact_annot(rect, fill=None)
                    has_redactions = True
            
            if has_redactions:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

            # Step 2: Draw the new text
            for edit in page_edits:
                bounds = edit.get("bounds")
                new_text = edit.get("newText", "")
                if not new_text.strip():
                    continue
                
                font_size = edit.get("fontSize", 12)
                rgb = hex_to_rgb(edit.get("color", "#000000"))
                
                fontname = "helv"
                family = edit.get("fontFamily", "").lower()
                if "times" in family or "serif" in family:
                    fontname = "tiro"
                elif "courier" in family or "mono" in family:
                    fontname = "cour"
                    
                if edit.get("fontWeight") == "bold":
                    if edit.get("fontStyle") == "italic":
                        fontname = fontname.replace("ro", "bi").replace("helv", "hebi").replace("cour", "cobi")
                    else:
                        fontname = fontname.replace("ro", "bo").replace("helv", "hebo").replace("cour", "cobo")
                elif edit.get("fontStyle") == "italic":
                    fontname = fontname.replace("ro", "it").replace("helv", "heit").replace("cour", "coit")

                if bounds:
                    insert_rect = fitz.Rect(
                        bounds["x"] / scale,
                        bounds["y"] / scale,
                        (bounds["x"] + bounds["w"]) / scale + 500,
                        (bounds["y"] + bounds["h"]) / scale + 500
                    )
                    try:
                        page.insert_textbox(insert_rect, new_text, fontname=fontname, fontsize=font_size, color=rgb, align=0)
                    except Exception as ex:
                        try:
                            page.insert_textbox(insert_rect, new_text, fontname="helv", fontsize=font_size, color=rgb, align=0)
                        except Exception:
                            safe_text = new_text.encode("ascii", "ignore").decode("ascii")
                            page.insert_textbox(insert_rect, safe_text, fontname="helv", fontsize=font_size, color=rgb, align=0)

        out_bytes = doc.write()
        doc.close()
        return Response(content=out_bytes, media_type="application/pdf")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn, os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)