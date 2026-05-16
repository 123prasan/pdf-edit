import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Annotation } from '../types'
import type { TextEdit } from '../components/TextEditLayer'

/* ============================================================
   Export PDF with Annotations AND Text Edits

   PDF coordinate system: origin bottom-left, y increases upward.
   pdf.js getTextContent() item.transform = [a,b,c,d,e,f]
     where (e, f) = position in PDF points (already in PDF space).
   For standard horizontal text: a=fontSize, d=fontSize, b=c=0.
   So fontSize = Math.sqrt(a² + b²) = a (for horizontal text).

   AnnotationLayer stores coords in canvas-pixel space (y-down, from top-left).
   We convert: pdfX = canvasPx / scale, pdfY = pageHeight - canvasPy / scale
   ============================================================ */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255,
  }
}

export async function exportPdfWithAnnotations(
  pdfBytes: Uint8Array,
  annotations: Annotation[],
  textEdits: TextEdit[],
  canvasScale: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)

  // ---- Apply text edits ----
  for (const edit of textEdits) {
    if (!edit.bounds) continue
    if (edit.newText === edit.originalText) continue

    const pageIndex = Math.max(0, edit.page - 1)
    if (pageIndex >= pdfDoc.getPageCount()) continue
    const page = pdfDoc.getPage(pageIndex)
    const pdfHeight = page.getHeight()

    // Convert Canvas pixels (y-down) to PDF points (y-up)
    const toX = (cx: number) => cx / canvasScale
    const toY = (cy: number) => pdfHeight - cy / canvasScale
    const toLen = (cl: number) => cl / canvasScale

    const x = toX(edit.bounds.x)
    // pdf-lib drawRectangle y is the bottom-left corner
    const bottomY = toY(edit.bounds.y + edit.bounds.h)

    // 1. Redact/Erase the old text by drawing a white box over its exact footprint
    page.drawRectangle({
      x,
      y: bottomY,
      width: toLen(edit.bounds.w),
      height: toLen(edit.bounds.h),
      color: rgb(1, 1, 1), // White
    })

    // 2. Draw new text into the PDF stream
    if (edit.newText.trim()) {
      const textCol = hexToRgb(edit.color || '#000000')
      // edit.fontSize is stored raw, already in PDF points
      const fontSize = edit.fontSize || toLen(edit.bounds.h) * 0.85

      try {
        page.drawText(edit.newText, {
          x,
          y: bottomY + (toLen(edit.bounds.h) * 0.2), // Adjust baseline slightly up
          size: fontSize,
          font: helvetica,
          color: rgb(textCol.r, textCol.g, textCol.b),
        })
      } catch (_) {
        // Fallback truncation for massive strings
        page.drawText(edit.newText.slice(0, 200), {
          x,
          y: bottomY + (toLen(edit.bounds.h) * 0.2),
          size: fontSize,
          font: helvetica,
          color: rgb(textCol.r, textCol.g, textCol.b),
        })
      }
    }
  }

  // ---- Apply annotation overlays ----
  for (const ann of annotations) {
    const pageIndex = Math.max(0, ann.page - 1)
    if (pageIndex >= pdfDoc.getPageCount()) continue
    const page = pdfDoc.getPage(pageIndex)
    const pdfHeight = page.getHeight()

    // Convert canvas-pixel coords (y-down) → PDF points (y-up)
    const toX = (cx: number) => cx / canvasScale
    const toY = (cy: number) => pdfHeight - cy / canvasScale
    const toLen = (cl: number) => cl / canvasScale

    if (ann.type === 'text' && ann.text) {
      const x = toX(ann.x)
      const baseY = toY(ann.y)

      // If we have character-level styling, draw each character with its own style
      if (ann.chars && ann.chars.length > 0) {
        let currentX = x
        let currentY = baseY
        const firstCharFontSize = (ann.chars[0]?.fontSize || 14) / canvasScale
        currentY -= firstCharFontSize

        for (const charStyle of ann.chars) {
          if (charStyle.char === '\n') {
            currentX = x
            const charFontSize = (charStyle.fontSize || 14) / canvasScale
            currentY -= charFontSize * 1.3
            continue
          }

          const charFontSize = (charStyle.fontSize || 14) / canvasScale
          const charCol = hexToRgb(charStyle.fontColor || '#000000')

          try {
            page.drawText(charStyle.char, {
              x: currentX,
              y: currentY,
              size: Math.max(charFontSize, 1),
              font: helvetica,
              color: rgb(charCol.r, charCol.g, charCol.b),
            })
            // Approximate character width for next position
            currentX += charFontSize * 0.5
          } catch (_) { }
        }
      } else {
        // Fallback to original behavior for backward compatibility
        const fontSize = (ann.fontSize || 14) / canvasScale
        const col = hexToRgb(ann.fontColor || '#000000')
        const lines = ann.text.split('\n')
        lines.forEach((line, i) => {
          if (!line) return
          try {
            page.drawText(line, {
              x,
              y: baseY - i * (fontSize * 1.3) - fontSize,
              size: Math.max(fontSize, 1),
              font: helvetica,
              color: rgb(col.r, col.g, col.b),
            })
          } catch (_) { }
        })
      }

    } else if (ann.type === 'highlight') {
      const col = hexToRgb(ann.color || '#fbbf24')
      const x = toX(ann.x)
      const y = toY(ann.y + ann.height)  // flip: top of rect in PDF space
      page.drawRectangle({
        x,
        y,
        width: toLen(ann.width),
        height: toLen(ann.height),
        color: rgb(col.r, col.g, col.b),
        opacity: ann.opacity ?? 0.3,
      })

    } else if (ann.type === 'ink' && ann.path && ann.path.length > 1) {
      const col = hexToRgb(ann.fontColor || '#818cf8')
      for (let i = 1; i < ann.path.length; i++) {
        const p0 = ann.path[i - 1]
        const p1 = ann.path[i]
        page.drawLine({
          start: { x: toX(p0.x), y: toY(p0.y) },
          end: { x: toX(p1.x), y: toY(p1.y) },
          thickness: Math.max(1.5 / canvasScale, 0.5),
          color: rgb(col.r, col.g, col.b),
          opacity: 1,
        })
      }
    }
  }

  const newBytes = await pdfDoc.save()
  return new Uint8Array(newBytes)
}
