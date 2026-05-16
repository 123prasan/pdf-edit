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
   ============================================================ */

export type TextEdit = {
  id: string
  page: number
  itemIndex: number
  originalText: string
  newText: string
  fontSize: number
  fontFamily: string
  color: string
  transform: number[]
  width: number
  height: number
  bounds?: { x: number; y: number; w: number; h: number }
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
  active: boolean
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
  active,
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
    fontSize: number
    fontFamily: string
    fontWeight: string
    fontStyle: string
    color: string
    transform?: string
    letterSpacing?: string
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
        const textContent = await pdfPage.getTextContent()
        if (cancelled) return

        textItemsRef.current = textContent.items

        const textDivs: HTMLElement[] = []
        let renderPromise: Promise<any> | null = null

        try {
          if (typeof (pdfjsLib as any).renderTextLayer === 'function') {
            const task = (pdfjsLib as any).renderTextLayer({
              textContentSource: textContent,
              textContent,
              container,
              viewport,
              textDivs,
            })
            renderPromise = task.promise ?? Promise.resolve()
          }
        } catch (_) {
          renderPromise = null
        }

        if (!renderPromise) {
          placeFallbackSpans(container, textContent, viewport, textDivs)
          renderPromise = Promise.resolve()
        }

        await renderPromise
        if (cancelled) return

        textDivs.forEach((el, i) => {
          if (el) el.dataset.itemIndex = String(i)
        })

        setRendered(true)
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return
        console.error('TextEditLayer render error:', err)
      }
    }

    doRender()
    return () => { cancelled = true }
  }, [pdfPage, viewport, page])

  // After render, erase canvas areas for existing edits
  useEffect(() => {
    if (!rendered) return
    const canvas = canvasRef.current
    if (!canvas) return

    const timer = setTimeout(() => {
      for (const edit of textEdits) {
        if (edit.page !== page) continue
        if (edit.bounds) {
          eraseCanvasArea(canvas, edit.bounds)
        }
      }
    }, 120)

    return () => clearTimeout(timer)
  }, [rendered, textEdits, page, canvasRef])

  // Focus editor when opened
  useEffect(() => {
    if (editingItem && editorRef.current) {
      editorRef.current.focus()
      // Move cursor to end
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

    // Erase canvas
    const canvas = canvasRef.current
    if (canvas) {
      const key = `${page}-${idx}`
      if (!savedCanvasRef.current.has(key)) {
        const saved = saveCanvasArea(canvas, bounds, containerRect)
        if (saved) savedCanvasRef.current.set(key, saved)
      }
      eraseCanvasArea(canvas, bounds)
    }

    // We map to our specific Google Fonts to ensure characters don't break during typing
    const { fontFamily, fontWeight, fontStyle } = getWebFontMetrics(rawItem?.fontName)

    // Capture exact letter spacing and scaling to prevent layout shifts
    const spanStyle = window.getComputedStyle(span)
    const exactTransform = span.style.transform || spanStyle.transform

    // The span's fontSize is unscaled. We must scale it by the viewport to match the screen.
    const unscaledFontSize = parseFloat(span.style.fontSize) || parseFloat(spanStyle.fontSize) || (bounds.h)
    const exactFontSize = unscaledFontSize * (viewport?.scale || scale)

    // Dynamically sample the exact text color from the canvas before we erase it!
    let exactColor = '#000000'
    if (canvas) {
      const pad = 2
      const x = Math.max(0, Math.floor((bounds.x + containerRect.left - canvas.getBoundingClientRect().left) * (viewport?.scale || scale)) - pad)
      const y = Math.max(0, Math.floor((bounds.y + containerRect.top - canvas.getBoundingClientRect().top) * (viewport?.scale || scale)) - pad)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // Sample a tiny 10x10 square in the middle of the text bounding box
        try {
          const sampleData = ctx.getImageData(x + Math.floor(bounds.w / 2), y + Math.floor(bounds.h / 2), 10, 10).data
          // Find the darkest (text) pixel in the sample
          let darkestIdx = 0
          let minLuminance = 255 * 3
          for (let i = 0; i < sampleData.length; i += 4) {
            const lum = sampleData[i] + sampleData[i + 1] + sampleData[i + 2]
            if (lum < minLuminance && sampleData[i + 3] > 0) {
              minLuminance = lum
              darkestIdx = i
            }
          }
          if (minLuminance < 700) { // Ensure we actually hit text, not white background
            exactColor = `rgb(${sampleData[darkestIdx]}, ${sampleData[darkestIdx + 1]}, ${sampleData[darkestIdx + 2]})`
          }
        } catch (_) { }
      }
    }

    setEditingItem({
      idx,
      text: existingEdit?.newText ?? rawItem.str,
      originalText: existingEdit?.originalText ?? rawItem.str,
      bounds,
      fontSize: exactFontSize,
      fontFamily,
      fontWeight,
      fontStyle,
      color: exactColor,
      transform: exactTransform !== 'none' ? exactTransform : undefined,
      letterSpacing: spanStyle.letterSpacing !== 'normal' ? spanStyle.letterSpacing : undefined
    })
  }, [active, page, textEdits, canvasRef, viewport?.scale, scale])

  // ---- Commit edit ----
  const commitEdit = useCallback(() => {
    if (!editingItem) return

    // Read directly from DOM to avoid stale state issues
    const currentText = editorRef.current?.textContent ?? editingItem.text
    const rawItem = textItemsRef.current[editingItem.idx]
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
        fontSize: editingItem.fontSize / scale,
        fontFamily: editingItem.fontFamily,
        fontWeight: editingItem.fontWeight,
        fontStyle: editingItem.fontStyle,
        transform: editingItem.transform,
        letterSpacing: editingItem.letterSpacing
      })
    } else {
      // Revert canvas
      const key = `${page}-${editingItem.idx}`
      const saved = savedCanvasRef.current.get(key)
      const canvas = canvasRef.current
      if (saved && canvas) {
        restoreCanvasArea(canvas, editingItem.bounds, hitLayerRef.current!, saved)
        savedCanvasRef.current.delete(key)
      }
    }

    setEditingItem(null)
  }, [editingItem, page, scale, textEdits, onTextEdit, canvasRef])

  const cancelEdit = useCallback(() => {
    if (!editingItem) return
    const key = `${page}-${editingItem.idx}`
    const saved = savedCanvasRef.current.get(key)
    const canvas = canvasRef.current
    if (saved && canvas) {
      restoreCanvasArea(canvas, editingItem.bounds, hitLayerRef.current!, saved)
      savedCanvasRef.current.delete(key)
    }
    setEditingItem(null)
  }, [editingItem, page, canvasRef])

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
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
            fontSize: editingItem.fontSize,
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
        return (
          <div
            key={edit.id}
            onClick={(e) => {
              if (!active) return
              e.stopPropagation()
              const rawItem = textItemsRef.current[edit.itemIndex]
              const { fontFamily, fontWeight, fontStyle } = getWebFontMetrics(rawItem?.fontName)
              setEditingItem({
                idx: edit.itemIndex,
                text: edit.newText,
                originalText: edit.originalText,
                bounds: edit.bounds!,
                fontSize: edit.bounds!.h * 0.85,
                fontFamily,
                fontWeight,
                fontStyle,
                color: edit.color,
              })
            }}
            style={{
              position: 'absolute',
              left: edit.bounds.x,
              top: edit.bounds.y,
              minWidth: edit.bounds.w,
              fontSize: edit.bounds.h * 0.85,
              fontFamily: getWebFontMetrics(textItemsRef.current[edit.itemIndex]?.fontName).fontFamily,
              fontWeight: getWebFontMetrics(textItemsRef.current[edit.itemIndex]?.fontName).fontWeight,
              fontStyle: getWebFontMetrics(textItemsRef.current[edit.itemIndex]?.fontName).fontStyle,
              color: edit.color,
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

    // ALWAYS inject the exact pdf.js internal font name first (e.g. "g_d0_f1")
    // This guarantees the original text looks 100% identical. 
    // If the user types a new character that isn't in the PDF's subset font, 
    // the browser will gracefully fall back to the visually similar Google Font!
    const baseFamily = pdfFontName ? `"${pdfFontName}", ` : ''

    if (fn.includes('times') || fn.includes('serif') || fn.includes('minion') || fn.includes('georgia')) {
      fontFamily = `${baseFamily}"Lora", "Playfair Display", Georgia, "Times New Roman", serif`
    } else if (fn.includes('courier') || fn.includes('mono') || fn.includes('consolas')) {
      fontFamily = `${baseFamily}"Courier Prime", "Courier New", Courier, monospace`
    } else if (fn.includes('arial') || fn.includes('helvetica') || fn.includes('sans')) {
      fontFamily = `${baseFamily}"Roboto", "Open Sans", Arial, Helvetica, sans-serif`
    } else {
      fontFamily = `${baseFamily}"Roboto", "Open Sans", Arial, Helvetica, sans-serif`
    }

    // Map weight
    if (fn.includes('bold') || fn.includes('black') || fn.includes('heavy')) {
      fontWeight = 'bold'
    }

    // Map style
    if (fn.includes('italic') || fn.includes('oblique')) {
      fontStyle = 'italic'
    }
  }

  return { fontFamily, fontWeight, fontStyle }
}

/* ---- Canvas helpers ---- */
function saveCanvasArea(canvas: HTMLCanvasElement, bounds: { x: number; y: number; w: number; h: number }, containerRect: DOMRect): ImageData | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const canvasRect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / canvasRect.width
  const scaleY = canvas.height / canvasRect.height

  const offsetX = containerRect ? (containerRect.left - canvasRect.left) : 0
  const offsetY = containerRect ? (containerRect.top - canvasRect.top) : 0

  const pad = 3
  const x = Math.max(0, Math.floor((bounds.x + offsetX) * scaleX) - pad)
  const y = Math.max(0, Math.floor((bounds.y + offsetY) * scaleY) - pad)
  const w = Math.min(canvas.width - x, Math.ceil(bounds.w * scaleX) + pad * 2)
  const h = Math.min(canvas.height - y, Math.ceil(bounds.h * scaleY) + pad * 2)

  if (w <= 0 || h <= 0) return null
  try { return ctx.getImageData(x, y, w, h) } catch (_) { return null }
}

function eraseCanvasArea(canvas: HTMLCanvasElement, bounds: { x: number; y: number; w: number; h: number }) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const canvasRect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / canvasRect.width
  const scaleY = canvas.height / canvasRect.height

  const pad = 2
  const x = Math.floor(bounds.x * scaleX) - pad
  const y = Math.floor(bounds.y * scaleY) - pad
  const w = Math.ceil(bounds.w * scaleX) + pad * 2
  const h = Math.ceil(bounds.h * scaleY) + pad * 2

  const sampleX = Math.max(0, Math.min(Math.floor(x + 4), canvas.width - 1))
  const sampleY = Math.max(0, Math.min(Math.floor(y - 4), canvas.height - 1))

  try {
    const pixel = ctx.getImageData(sampleX, sampleY, 1, 1).data
    ctx.fillStyle = pixel[3] === 0 ? '#ffffff' : `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`
  } catch (_) {
    ctx.fillStyle = '#ffffff'
  }

  ctx.fillRect(
    Math.max(0, x), Math.max(0, y),
    Math.min(w, canvas.width - Math.max(0, x)), Math.min(h, canvas.height - Math.max(0, y))
  )
}

function restoreCanvasArea(canvas: HTMLCanvasElement, bounds: { x: number; y: number; w: number; h: number }, container: HTMLElement, imageData: ImageData) {
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

function placeFallbackSpans(container: HTMLDivElement, textContent: any, viewport: any, textDivs: HTMLElement[]) {
  const vt = viewport.transform
  for (const item of textContent.items as any[]) {
    if (!item.str) continue
    const span = document.createElement('span')
    span.textContent = item.str
    const tx = item.transform
    const a = vt[0] * tx[0] + vt[2] * tx[1]
    const b = vt[1] * tx[0] + vt[3] * tx[1]
    const c = vt[0] * tx[2] + vt[2] * tx[3]
    const d = vt[1] * tx[2] + vt[3] * tx[3]
    const e = vt[0] * tx[4] + vt[2] * tx[5] + vt[4]
    const f = vt[1] * tx[4] + vt[3] * tx[5] + vt[5]
    const fontSize = Math.sqrt(a * a + b * b)

    span.style.cssText = `
      position: absolute; left: 0; top: 0; font-size: ${fontSize}px;
      transform: matrix(${a / fontSize}, ${b / fontSize}, ${c / fontSize}, ${d / fontSize}, ${e}, ${f - fontSize});
      transform-origin: 0% 0%; white-space: pre; color: transparent; cursor: text;
    `
    container.appendChild(span)
    textDivs.push(span)
  }
}
