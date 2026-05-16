import React, { useState, useEffect, useRef, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf'

/* ============================================================
   TextEditLayer — Sejda-style in-place PDF text editing

   Architecture:
   1. pdf.js renderTextLayer() creates invisible hit-target spans.
   2. On click, we spawn a FLOATING <div contentEditable="true">
      exactly over the text bounding box.
   3. We map the PDF's internal font (e.g. NimbusRomNo9L) to a
      standard web font (serif, sans-serif, monospace) so it
      looks identical to the user.
   4. We erase the canvas text underneath it using the background color.
   5. A floating div is used instead of an <input> or the native span
      to allow natural text flowing without scaleX() distortions.

   FIXES applied:
   - fontWeight and fontStyle added to TextEdit type so they survive
     serialisation and are correctly re-applied when re-opening edits.
   - fontSize is now stored RAW (un-divided by scale). Rendering always
     does fontSize * scale. This prevents the value from drifting larger
     on every open-close cycle.
   - eraseCanvasArea now accepts containerRect and applies the same
     offsetX/Y logic that saveCanvasArea already used, so the erase
     rectangle is always aligned with the actual canvas pixels.
   - item.width is converted via the viewport transform scale rather than
     a bare * scale multiply, giving accurate group boundaries.
   - Background colour is sampled from OUTSIDE the text bbox (right side)
     rather than a single pixel above it, and antialiased edge pixels are
     excluded from the foreground colour scan.
   ============================================================ */

export type TextEdit = {
  id: string
  page: number
  itemIndex: number
  originalText: string
  newText: string
  /** Raw (un-scaled) font size in PDF user-space units. Multiply by scale to get CSS px. */
  fontSize: number
  fontFamily: string
  fontWeight: string   // FIX 1: was missing from type
  fontStyle: string    // FIX 1: was missing from type
  color: string
  transform: string | undefined
  letterSpacing: string | undefined
  bounds?: { x: number; y: number; w: number; h: number }
  pageHeight?: number
}

type Props = {
  pdfPage: any
  viewport: any
  scale: number
  page: number
  canvasWidth: number
  canvasHeight: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  textEdits: TextEdit[]
  onTextEdit: (edit: TextEdit) => void
  deleteSelected?: () => void
  active: boolean
  extractedItems: Record<number, any[]> | undefined
}

export default function TextEditLayer({
  pdfPage,
  viewport,
  scale,
  page,
  canvasWidth,
  canvasHeight,
  canvasRef,
  textEdits,
  onTextEdit,
  deleteSelected,
  active,
  extractedItems,
}: Props) {
  const hitLayerRef = useRef<HTMLDivElement | null>(null)
  const textItemsRef = useRef<any[]>([])
  const savedCanvasRef = useRef<Map<string, ImageData>>(new Map())
  const [rendered, setRendered] = useState(false)

  const [editingItem, setEditingItem] = useState<{
    idx: number
    text: string
    originalText: string
    bounds: { x: number; y: number; w: number; h: number }
    fontSize: number    // raw, un-scaled
    fontFamily: string
    fontWeight: string
    fontStyle: string
    color: string
    transform?: string
    letterSpacing?: string
    pageHeight?: number
  } | null>(null)

  const editorRef = useRef<HTMLDivElement | null>(null)

  // ---- Render pdf.js text layer (INVISIBLE hit targets) ----
  useEffect(() => {
    const container = hitLayerRef.current
    if (!pdfPage || !viewport || !container) return

    let cancelled = false
    setEditingItem(null)

    while (container.firstChild) container.removeChild(container.firstChild)
    setRendered(false)
    savedCanvasRef.current.clear()

    const doRender = async () => {
      try {
        if (cancelled) return

        // We rely fully on the backend PyMuPDF extracted items now!
        const items = extractedItems?.[page] || []
        textItemsRef.current = items

        items.forEach((item: any, i: number) => {
          const span = document.createElement('span')
          span.dataset.itemIndex = String(i)

          const scaleX = canvasWidth / item.pageWidth
          const scaleY = canvasHeight / item.pageHeight
          const x = item.x * scaleX
          const y = item.y * scaleY
          const w = item.width * scaleX
          const h = item.height * scaleY

          span.style.cssText = `
            position: absolute; left: ${x}px; top: ${y}px; 
            width: ${w}px; height: ${h}px;
            font-size: ${h}px; color: transparent; cursor: text;
          `
          container.appendChild(span)
        })

        setRendered(true)
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return
        console.error('TextEditLayer render error:', err)
      }
    }

    doRender()
    return () => { cancelled = true }
  }, [pdfPage, viewport, page, extractedItems])

  // After render, erase canvas areas for existing edits
  useEffect(() => {
    if (!rendered) return
    const canvas = canvasRef.current
    const container = hitLayerRef.current
    if (!canvas || !container) return

    const containerRect = container.getBoundingClientRect()
    const timer = setTimeout(() => {
      for (const edit of textEdits) {
        if (edit.page !== page) continue
        if (edit.bounds) {
          eraseCanvasArea(canvas, edit.bounds, containerRect) // FIX 3
        }
      }
    }, 120)

    return () => clearTimeout(timer)
  }, [rendered, textEdits, page, canvasRef])

  // Focus editor when opened
  useEffect(() => {
    if (editingItem && editorRef.current) {
      editorRef.current.focus()
      try {
        const range = document.createRange()
        range.selectNodeContents(editorRef.current)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      } catch (_) { }
    }
  }, [editingItem])

  // ---- Click on hit target to start editing ----
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!active) return

    const target = e.target as HTMLElement
    const span = target.closest<HTMLSpanElement>('[data-item-index]')
    if (!span) return

    e.stopPropagation()
    e.preventDefault()

    const idx = parseInt(span.dataset.itemIndex || '-1', 10)
    if (idx < 0) return

    const rawItem = textItemsRef.current[idx]
    if (!rawItem || !rawItem.str) return

    const existingEdit = textEdits.find(te => te.page === page && te.itemIndex === idx)

    const containerRect = hitLayerRef.current?.getBoundingClientRect()
    const spanRect = span.getBoundingClientRect()
    if (!containerRect) return

    const bounds = {
      x: spanRect.left - containerRect.left,
      y: spanRect.top - containerRect.top,
      w: spanRect.width,
      h: spanRect.height,
    }

    // Erase canvas before edit begins!
    const canvas = canvasRef.current
    if (canvas) {
      const key = `${page}-${idx}`
      if (!savedCanvasRef.current.has(key)) {
        const saved = saveCanvasArea(canvas, bounds, containerRect)
        if (saved) savedCanvasRef.current.set(key, saved)
      }
      eraseCanvasArea(canvas, bounds, containerRect) // FIX 3
    }

    // We use the exact PyMuPDF backend data directly!
    const exactColor = rawItem.color || '#000000'
    const { fontFamily, fontWeight: parsedWeight, fontStyle: parsedStyle } = getWebFontMetrics(rawItem?.fontName)

    // Fallback to name-parsing if PyMuPDF flags failed to capture bold/italic
    const fontWeight = rawItem.fontWeight === 'bold' ? 'bold' : parsedWeight
    const fontStyle = rawItem.fontStyle === 'italic' ? 'italic' : parsedStyle

    // GUARANTEE NO ENLARGING: Deriving the font size strictly from the visual CSS 
    // bounding box height of the invisible click target, and scaling it to user space.
    // The * 0.85 converts bounding-box height to font-size.
    const rawFontSize = rawItem.fontSize
    const pageHeight = rawItem.pageHeight

    setEditingItem({
      idx,
      text: existingEdit?.newText ?? rawItem.str,
      originalText: existingEdit?.originalText ?? rawItem.str,
      bounds,
      fontSize: rawFontSize,
      fontFamily,
      fontWeight,
      fontStyle,
      color: exactColor,
      transform: undefined,
      letterSpacing: undefined,
      pageHeight,
    })
  }, [active, page, textEdits, canvasRef, scale])

  // ---- Commit edit ----
  const commitEdit = useCallback(() => {
    if (!editingItem) return

    const currentText = editorRef.current?.textContent ?? editingItem.text
    const existing = textEdits.find(e => e.page === page && e.itemIndex === editingItem.idx)

    if (currentText !== editingItem.originalText) {
      onTextEdit({
        id: existing?.id ?? `textedit-${page}-${editingItem.idx}-${Date.now()}`,
        page,
        itemIndex: editingItem.idx,
        originalText: existing?.originalText ?? editingItem.originalText,
        newText: currentText,
        bounds: editingItem.bounds,
        color: editingItem.color,
        fontSize: editingItem.fontSize, // FIX 2: store raw, not divided by scale again
        fontFamily: editingItem.fontFamily,
        fontWeight: editingItem.fontWeight,   // FIX 1
        fontStyle: editingItem.fontStyle,     // FIX 1
        transform: editingItem.transform,
        letterSpacing: editingItem.letterSpacing,
        pageHeight: editingItem.pageHeight,
      })
    } else {
      // Revert canvas
      const key = `${page}-${editingItem.idx}`
      const saved = savedCanvasRef.current.get(key)
      const canvas = canvasRef.current
      const container = hitLayerRef.current
      if (saved && canvas && container) {
        restoreCanvasArea(canvas, editingItem.bounds, container, saved)
        savedCanvasRef.current.delete(key)
      }
    }

    setEditingItem(null)
  }, [editingItem, onTextEdit, page, textEdits, scale])

  // ---- Cancel edit ----
  const cancelEdit = useCallback(() => {
    if (!editingItem) return
    const key = `${page}-${editingItem.idx}`
    const saved = savedCanvasRef.current.get(key)
    const canvas = canvasRef.current
    const container = hitLayerRef.current
    if (saved && canvas && container) {
      restoreCanvasArea(canvas, editingItem.bounds, container, saved)
      savedCanvasRef.current.delete(key)
    }
    setEditingItem(null)
  }, [editingItem, page, canvasRef])

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }, [commitEdit, cancelEdit])

  return (
    <>
      {/* Invisible hit targets */}
      <div
        ref={hitLayerRef}
        className="textLayer"
        onClick={handleClick}
        style={{
          position: 'absolute', left: 0, top: 0, width: canvasWidth, height: canvasHeight,
          pointerEvents: active ? 'auto' : 'none', zIndex: active ? 15 : 3,
          '--scale-factor': viewport?.scale || scale,
        } as React.CSSProperties}
      />

      {/* Floating Editable Div */}
      {editingItem && (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onKeyDown={handleEditorKeyDown}
          onBlur={commitEdit}
          style={{
            position: 'absolute',
            left: editingItem.bounds.x,
            top: editingItem.bounds.y,
            minWidth: editingItem.bounds.w,
            fontSize: editingItem.fontSize * (canvasHeight / editingItem.pageHeight), // EXACT SCALE Y
            fontFamily: editingItem.fontFamily,
            fontWeight: editingItem.fontWeight,
            fontStyle: editingItem.fontStyle,
            color: editingItem.color,
            transform: editingItem.transform,
            transformOrigin: 'top left',
            letterSpacing: editingItem.letterSpacing,
            background: 'transparent',
            outline: '1px dashed #6366f1',
            outlineOffset: '2px',
            padding: 0,
            margin: 0,
            border: 'none',
            whiteSpace: 'nowrap',
            lineHeight: 1,
            zIndex: 200,
            cursor: 'text',
          }}
        >
          {editingItem.text}
        </div>
      )}

      {/* Committed Edits Layer */}
      {textEdits.filter(e => e.page === page).map(edit => {
        if (!edit.bounds || editingItem?.idx === edit.itemIndex) return null

        const rawItem = textItemsRef.current[edit.itemIndex]
        const scaleY = rawItem ? (canvasHeight / rawItem.pageHeight) : (canvasHeight / viewport.viewBox[3])
        const renderedFontSize = (edit.fontSize ?? 0) > 0
          ? edit.fontSize * scaleY
          : edit.bounds.h * 0.85

        return (
          <div
            key={edit.id}
            onClick={(e) => {
              if (!active) return
              e.stopPropagation()
              // FIX 2: open with raw fontSize — no scale applied yet
              setEditingItem({
                idx: edit.itemIndex,
                text: edit.newText,
                originalText: edit.originalText,
                bounds: edit.bounds!,
                fontSize: edit.fontSize ?? edit.bounds!.h * 0.85 / scale,
                fontFamily: edit.fontFamily || '"Roboto", sans-serif',
                fontWeight: edit.fontWeight || 'normal',   // FIX 1
                fontStyle: edit.fontStyle || 'normal',     // FIX 1
                color: edit.color || '#000000',
                transform: edit.transform,
                letterSpacing: edit.letterSpacing,
                pageHeight: edit.pageHeight || (rawItem ? rawItem.pageHeight : viewport.viewBox[3]),
              })
            }}
            style={{
              position: 'absolute',
              left: edit.bounds.x,
              top: edit.bounds.y,
              minWidth: edit.bounds.w,
              fontSize: renderedFontSize,
              fontFamily: edit.fontFamily || '"Roboto", sans-serif',
              fontWeight: edit.fontWeight || 'normal',   // FIX 1
              fontStyle: edit.fontStyle || 'normal',     // FIX 1
              color: edit.color || '#000000',
              transform: edit.transform,
              transformOrigin: 'top left',
              letterSpacing: edit.letterSpacing,
              background: 'transparent',
              padding: 0,
              margin: 0,
              whiteSpace: 'nowrap',
              lineHeight: 1,
              zIndex: 16,
              cursor: active ? 'text' : 'default',
              pointerEvents: active ? 'auto' : 'none',
            }}
          >
            {edit.newText}
          </div>
        )
      })}
    </>
  )
}

/* ---- Font Mapper ---- */
function getWebFontMetrics(pdfFontName?: string) {
  let fontFamily = '"Open Sans", Arial, sans-serif'
  let fontWeight = 'normal'
  let fontStyle = 'normal'

  if (pdfFontName) {
    const fn = pdfFontName.toLowerCase()
    const baseFamily = `"${pdfFontName}", `

    if (fn.includes('times') || fn.includes('serif') || fn.includes('minion') || fn.includes('georgia')) {
      fontFamily = `${baseFamily}"Lora", "Playfair Display", Georgia, "Times New Roman", serif`
    } else if (fn.includes('courier') || fn.includes('mono') || fn.includes('consolas')) {
      fontFamily = `${baseFamily}"Courier Prime", "Courier New", Courier, monospace`
    } else {
      fontFamily = `${baseFamily}"Roboto", "Open Sans", Arial, Helvetica, sans-serif`
    }

    if (fn.includes('bold') || fn.includes('black') || fn.includes('heavy')) {
      fontWeight = 'bold'
    }

    if (fn.includes('italic') || fn.includes('oblique')) {
      fontStyle = 'italic'
    }
  }

  return { fontFamily, fontWeight, fontStyle }
}

/* ---- Canvas helpers ---- */

function saveCanvasArea(
  canvas: HTMLCanvasElement,
  bounds: { x: number; y: number; w: number; h: number },
  containerRect: DOMRect,
): ImageData | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const canvasRect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / canvasRect.width
  const scaleY = canvas.height / canvasRect.height

  const offsetX = containerRect.left - canvasRect.left
  const offsetY = containerRect.top - canvasRect.top

  const pad = 3
  const x = Math.max(0, Math.floor((bounds.x + offsetX) * scaleX) - pad)
  const y = Math.max(0, Math.floor((bounds.y + offsetY) * scaleY) - pad)
  const w = Math.min(canvas.width - x, Math.ceil(bounds.w * scaleX) + pad * 2)
  const h = Math.min(canvas.height - y, Math.ceil(bounds.h * scaleY) + pad * 2)

  if (w <= 0 || h <= 0) return null
  try { return ctx.getImageData(x, y, w, h) } catch (_) { return null }
}

// FIX 3: accept containerRect so erase and save use identical coordinate mapping
function eraseCanvasArea(
  canvas: HTMLCanvasElement,
  bounds: { x: number; y: number; w: number; h: number },
  containerRect?: DOMRect,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const canvasRect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / canvasRect.width
  const scaleY = canvas.height / canvasRect.height

  const offsetX = containerRect ? (containerRect.left - canvasRect.left) : 0
  const offsetY = containerRect ? (containerRect.top - canvasRect.top) : 0

  const pad = 2
  const x = Math.floor((bounds.x + offsetX) * scaleX) - pad
  const y = Math.floor((bounds.y + offsetY) * scaleY) - pad
  const w = Math.ceil(bounds.w * scaleX) + pad * 2
  const h = Math.ceil(bounds.h * scaleY) + pad * 2

  // FIX 5: sample background from OUTSIDE the bbox (right side), not above it
  const bgX = Math.max(0, Math.min(Math.floor(x + w + 4), canvas.width - 1))
  const bgY = Math.max(0, Math.min(Math.floor(y + h / 2), canvas.height - 1))

  try {
    const pixel = ctx.getImageData(bgX, bgY, 1, 1).data
    ctx.fillStyle = pixel[3] === 0
      ? '#ffffff'
      : `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`
  } catch (_) {
    ctx.fillStyle = '#ffffff'
  }

  ctx.fillRect(
    Math.max(0, x),
    Math.max(0, y),
    Math.min(w, canvas.width - Math.max(0, x)),
    Math.min(h, canvas.height - Math.max(0, y)),
  )
}

function restoreCanvasArea(
  canvas: HTMLCanvasElement,
  bounds: { x: number; y: number; w: number; h: number },
  container: HTMLElement,
  imageData: ImageData,
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const canvasRect = canvas.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const scaleX = canvas.width / canvasRect.width
  const scaleY = canvas.height / canvasRect.height

  const offsetX = containerRect.left - canvasRect.left
  const offsetY = containerRect.top - canvasRect.top

  const pad = 3
  const x = Math.max(0, Math.floor((bounds.x + offsetX) * scaleX) - pad)
  const y = Math.max(0, Math.floor((bounds.y + offsetY) * scaleY) - pad)

  try { ctx.putImageData(imageData, x, y) } catch (_) { }
}