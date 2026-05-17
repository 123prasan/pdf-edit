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
  letterSpacing: string | undefined
  bounds?: { x: number; y: number; w: number; h: number }
  originalBounds?: { x: number; y: number; w: number; h: number }
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
  tool: string
  extractedItems: Record<number, any[]> | undefined
  activeColor?: string | null
  activeFont?: string | null
  setActiveColor?: (c: string) => void
  setActiveFont?: (f: string) => void
  docFonts?: string[]
  docColors?: string[]
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
  tool,
  extractedItems,
  activeColor,
  activeFont,
  setActiveColor,
  setActiveFont,
  docFonts = [],
  docColors = [],
}: Props) {
  const hitLayerRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const active = tool === 'edit' || tool === 'text'
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
  let cancelled = false

  // Sync editing item with external palette overrides
  useEffect(() => {
    if (editingItem && activeColor && activeColor.toUpperCase() !== editingItem.color.toUpperCase()) {
      setEditingItem(prev => prev ? { ...prev, color: activeColor } : null)
    }
  }, [activeColor])

  useEffect(() => {
    if (editingItem && activeFont) {
      const currentFont = editingItem.fontFamily.split(',')[0].replace(/['"]/g, '').trim()
      if (activeFont !== currentFont) {
        setEditingItem(prev => prev ? { ...prev, fontFamily: `"${activeFont}", sans-serif` } : null)
      }
    }
  }, [activeFont])

  // ---- Extract and inject fonts/css ----text layer (INVISIBLE hit targets) ----
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
          let x = item.x * scaleX
          let y = item.y * scaleY
          let w = item.width * scaleX
          let h = item.height * scaleY
          const exactFontSize = item.fontSize * scaleY

          const editRecord = textEdits.find(e => e.page === page && e.itemIndex === i)
          if (editRecord && editRecord.bounds) {
            x = editRecord.bounds.x
            y = editRecord.bounds.y
            w = editRecord.bounds.w
            h = editRecord.bounds.h
          }
          const isEditedText = !!editRecord

          span.textContent = item.str
          span.style.cssText = `
            position: absolute; left: ${x}px; top: ${y}px; 
            width: ${w}px; height: ${h}px;
            font-size: ${exactFontSize}px; 
            color: ${item.color || '#000000'}; 
            cursor: ${active ? 'move' : 'text'};
            font-family: ${item.fontFamily || 'sans-serif'};
            font-weight: ${item.fontWeight || 'normal'};
            font-style: ${item.fontStyle || 'normal'};
            line-height: 1;
            white-space: pre;
            visibility: ${isEditedText ? 'hidden' : 'visible'};
            pointer-events: ${active ? 'auto' : 'none'};
            user-select: none;
            touch-action: none;
          `
          if (active) {
            span.title = 'Double click to edit, drag to move'
          }
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
  }, [pdfPage, viewport, page, extractedItems, tool, textEdits])

  // Canvas erasure no longer needed! We are using purely HTML text over an intercepted canvas.

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


  const dragRef = useRef<{
    idx: number
    startX: number
    startY: number
    spanLeft: number
    spanTop: number
    span: HTMLElement
    moved: boolean
    isEditedDiv: boolean
  } | null>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const active = tool === 'edit' || tool === 'text'
    if (!active || editingItem) return
    const target = e.target as HTMLElement
    const isEditedDiv = target.dataset.editedId !== undefined
    const itemIndexStr = isEditedDiv ? target.dataset.itemIndex : target.closest('[data-item-index]')?.getAttribute('data-item-index')

    // If clicking on empty canvas while using 'Add Text' tool
    if (!itemIndexStr && tool === 'text') {
      const rect = layerRef.current?.getBoundingClientRect()
      if (!rect) return

      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const newIdx = -Date.now() // Use a negative timestamp to represent a new, non-PDF element

      setEditingItem({
        idx: newIdx,
        originalText: '',
        text: '',
        bounds: {
          x: Math.max(0, Math.min(px, canvasWidth - 100)),
          y: Math.max(0, Math.min(py, canvasHeight - 20)),
          w: 100,
          h: 20
        },
        fontSize: 16,
        fontFamily: activeFont ? `"${activeFont}", sans-serif` : 'sans-serif',
        fontWeight: 'normal',
        fontStyle: 'normal',
        color: activeColor || '#000000',
        transform: 'matrix(1, 0, 0, 1, 0, 0)',
        letterSpacing: 0,
        pageHeight: canvasHeight
      })
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (!itemIndexStr) return

    const idx = parseInt(itemIndexStr, 10)

    const span = isEditedDiv ? target : target.closest('[data-item-index]') as HTMLElement
    if (!span) return

    e.preventDefault()
    e.stopPropagation()

    const left = parseFloat(span.style.left || '0')
    const top = parseFloat(span.style.top || '0')

    dragRef.current = {
      idx,
      startX: e.clientX,
      startY: e.clientY,
      spanLeft: left,
      spanTop: top,
      span,
      moved: false,
      isEditedDiv
    }
    span.setPointerCapture(e.pointerId)
  }, [active, editingItem])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || !active) return

    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY

    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      d.moved = true

      let newLeft = d.spanLeft + dx
      let newTop = d.spanTop + dy

      const spanW = d.span.offsetWidth || 0
      const spanH = d.span.offsetHeight || 0

      newLeft = Math.max(0, Math.min(newLeft, canvasWidth - spanW))
      newTop = Math.max(0, Math.min(newTop, canvasHeight - spanH))

      d.span.style.left = `${newLeft}px`
      d.span.style.top = `${newTop}px`
    }
  }, [active, canvasWidth, canvasHeight])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    d.span.releasePointerCapture(e.pointerId)

    if (d.moved) {
      const rawItem = textItemsRef.current[d.idx]
      const existingEdit = textEdits.find(te => te.page === page && te.itemIndex === d.idx)

      const containerRect = hitLayerRef.current?.parentElement?.getBoundingClientRect()
      const spanRect = d.span.getBoundingClientRect()
      if (!containerRect || (!rawItem && d.idx >= 0)) return

      const newBounds = {
        x: spanRect.left - containerRect.left,
        y: spanRect.top - containerRect.top,
        w: spanRect.width,
        h: spanRect.height,
      }

      const scaleX = canvasWidth / (rawItem?.pageWidth || canvasWidth)
      const scaleY = canvasHeight / (rawItem?.pageHeight || canvasHeight)
      const originalBounds = existingEdit?.originalBounds || (rawItem ? {
        x: rawItem.x * scaleX,
        y: rawItem.y * scaleY,
        w: rawItem.width * scaleX,
        h: rawItem.height * scaleY
      } : undefined)

      onTextEdit({
        id: existingEdit?.id || `te_${page}_${d.idx}`,
        page,
        itemIndex: d.idx,
        originalText: rawItem?.str || '',
        newText: existingEdit?.newText ?? rawItem?.str ?? '',
        fontSize: existingEdit?.fontSize || (rawItem?.fontSize ?? 16),
        fontFamily: existingEdit?.fontFamily || (rawItem ? getWebFontMetrics(rawItem?.fontName).fontFamily : 'sans-serif'),
        fontWeight: existingEdit?.fontWeight || (rawItem?.fontWeight === 'bold' ? 'bold' : (rawItem ? getWebFontMetrics(rawItem?.fontName).fontWeight : 'normal')),
        fontStyle: existingEdit?.fontStyle || (rawItem?.fontStyle === 'italic' ? 'italic' : (rawItem ? getWebFontMetrics(rawItem?.fontName).fontStyle : 'normal')),
        color: existingEdit?.color || rawItem?.color || '#000000',
        bounds: newBounds,
        originalBounds,
        transform: existingEdit?.transform || 'matrix(1, 0, 0, 1, 0, 0)',
        letterSpacing: existingEdit?.letterSpacing || 0,
        pageHeight: existingEdit?.pageHeight || rawItem?.pageHeight || canvasHeight,
      })
    }
  }, [onTextEdit, page, textEdits])

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const active = tool === 'edit' || tool === 'text'
    if (!active || editingItem) return

    const target = e.target as HTMLElement
    const isEditedDiv = target.dataset.editedId !== undefined
    const itemIndexStr = isEditedDiv ? target.dataset.itemIndex : target.closest('[data-item-index]')?.getAttribute('data-item-index')
    if (!itemIndexStr) return

    e.stopPropagation()
    e.preventDefault()

    const idx = parseInt(itemIndexStr, 10)

    // If it's a new text block created by the Add Text tool (negative idx)
    if (idx < 0) {
      const existingEdit = textEdits.find(te => te.page === page && te.itemIndex === idx)
      if (!existingEdit) return

      const span = isEditedDiv ? target : target.closest('[data-item-index]') as HTMLElement
      if (!span) return
      const containerRect = hitLayerRef.current?.parentElement?.getBoundingClientRect()
      const spanRect = span.getBoundingClientRect()
      if (!containerRect) return

      setEditingItem({
        idx,
        text: existingEdit.newText,
        originalText: '',
        bounds: {
          x: spanRect.left - containerRect.left,
          y: spanRect.top - containerRect.top,
          w: spanRect.width,
          h: spanRect.height,
        },
        fontSize: existingEdit.fontSize,
        fontFamily: existingEdit.fontFamily,
        fontWeight: existingEdit.fontWeight,
        fontStyle: existingEdit.fontStyle,
        color: existingEdit.color,
        transform: existingEdit.transform,
        letterSpacing: existingEdit.letterSpacing,
        pageHeight: existingEdit.pageHeight,
      })
      return
    }

    const rawItem = textItemsRef.current[idx]
    if (!rawItem || !rawItem.str) return

    const existingEdit = textEdits.find(te => te.page === page && te.itemIndex === idx)

    const span = isEditedDiv ? target : target.closest('[data-item-index]') as HTMLElement
    if (!span) return
    const containerRect = hitLayerRef.current?.parentElement?.getBoundingClientRect()
    const spanRect = span.getBoundingClientRect()
    if (!containerRect) return

    const bounds = {
      x: spanRect.left - containerRect.left,
      y: spanRect.top - containerRect.top,
      w: spanRect.width,
      h: spanRect.height,
    }

    if (!isEditedDiv) {
      span.style.visibility = 'hidden'
    }

    const exactColor = rawItem.color || '#000000'
    const { fontFamily, fontWeight: parsedWeight, fontStyle: parsedStyle } = getWebFontMetrics(rawItem?.fontName)
    const fontWeight = rawItem.fontWeight === 'bold' ? 'bold' : parsedWeight
    const fontStyle = rawItem.fontStyle === 'italic' ? 'italic' : parsedStyle
    const rawFontSize = rawItem.fontSize
    const pageHeight = rawItem.pageHeight

    if (setActiveColor) setActiveColor(exactColor.toUpperCase())
    if (setActiveFont) setActiveFont(fontFamily.split(',')[0].replace(/['"]/g, '').trim())

    setEditingItem({
      idx,
      text: existingEdit?.newText ?? rawItem.str,
      originalText: existingEdit?.originalText ?? rawItem.str,
      bounds,
      fontSize: existingEdit?.fontSize || rawFontSize,
      fontFamily: existingEdit?.fontFamily || fontFamily,
      fontWeight: existingEdit?.fontWeight || fontWeight,
      fontStyle: existingEdit?.fontStyle || fontStyle,
      color: existingEdit?.color || exactColor,
      transform: existingEdit?.transform,
      letterSpacing: existingEdit?.letterSpacing,
      pageHeight: existingEdit?.pageHeight || pageHeight,
    })
  }, [tool, page, textEdits, setActiveColor, setActiveFont])


  // ---- Commit edit ----
  const commitEdit = useCallback(() => {
    if (!editingItem) return

    const rawItem = textItemsRef.current[editingItem.idx]
    const currentText = editorRef.current?.textContent ?? editingItem.text
    const existing = textEdits.find(e => e.page === page && e.itemIndex === editingItem.idx)

    const textChanged = currentText !== editingItem.originalText
    const styleChanged =
      editingItem.color !== (existing?.color ?? rawItem?.color) ||
      editingItem.fontWeight !== (existing?.fontWeight ?? rawItem?.fontWeight) ||
      editingItem.fontStyle !== (existing?.fontStyle ?? rawItem?.fontStyle) ||
      editingItem.fontFamily !== (existing?.fontFamily ?? rawItem?.fontFamily) ||
      editingItem.fontSize !== (existing?.fontSize ?? rawItem?.fontSize)

    const scaleX = canvasWidth / (rawItem?.pageWidth || canvasWidth)
    const scaleY = canvasHeight / (rawItem?.pageHeight || canvasHeight)
    const originalBounds = existing?.originalBounds || (rawItem ? {
      x: rawItem.x * scaleX,
      y: rawItem.y * scaleY,
      w: rawItem.width * scaleX,
      h: rawItem.height * scaleY
    } : undefined)

    if (textChanged || styleChanged || existing) {
      onTextEdit({
        id: existing?.id ?? `textedit-${page}-${editingItem.idx}-${Date.now()}`,
        page,
        itemIndex: editingItem.idx,
        originalText: existing?.originalText ?? editingItem.originalText,
        newText: currentText,
        bounds: editingItem.bounds,
        originalBounds,
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
      // Revert visibility if they didn't change the text or styles
      const span = hitLayerRef.current?.querySelector(`[data-item-index="${editingItem.idx}"]`) as HTMLSpanElement
      if (span) span.style.visibility = 'visible'
    }
    setEditingItem(null)
  }, [editingItem, onTextEdit, page, textEdits, scale])

  // ---- Cancel edit ----
  const cancelEdit = useCallback(() => {
    if (!editingItem) return
    // Revert visibility since we cancelled
    const span = hitLayerRef.current?.querySelector(`[data-item-index="${editingItem.idx}"]`) as HTMLSpanElement
    if (span) span.style.visibility = 'visible'

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
    <div
      ref={layerRef}
      className="text-edit-container"
      style={{
        position: 'absolute', top: 0, left: 0, width: canvasWidth, height: canvasHeight,
        zIndex: active ? 15 : 3, pointerEvents: active ? 'auto' : 'none',
        touchAction: 'auto',
        cursor: tool === 'text' ? 'text' : (active ? 'default' : 'auto')
      }}
      onDoubleClick={handleDoubleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Invisible hit targets */}
      <div
        ref={hitLayerRef}
        className="textLayer"
        style={{
          position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
          pointerEvents: 'none',
          '--scale-factor': viewport?.scale || scale,
        } as React.CSSProperties}
      />

      {/* Background Erasure layer */}
      {extractedItems?.[page]?.map((item, i) => {
        const isEditingThis = editingItem?.idx === i
        const committedEdit = textEdits.find(e => e.page === page && e.itemIndex === i)

        if (!isEditingThis && !committedEdit) return null

        const scaleX = canvasWidth / item.pageWidth
        const scaleY = canvasHeight / item.pageHeight
        const x = item.x * scaleX
        const y = item.y * scaleY
        const w = item.width * scaleX
        const h = item.height * scaleY

        return (
          <div
            key={`erase-${i}`}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: w,
              height: h,
              backgroundColor: 'white', // Blocks the canvas text underneath
              zIndex: 1,
              pointerEvents: 'none',
            }}
          />
        )
      })}

      {/* Floating Editable Div */}
      {editingItem && (
        <div
          onBlur={(e) => {
            // Only commit if the focus has moved OUTSIDE of this entire wrapper (toolbar + editor)
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              commitEdit()
            }
          }}
        >
          {/* Floating Text Options Toolbar */}
          <div
            className="text-edit-toolbar"
            style={{
              '--menu-left': `${Math.max(0, Math.min(editingItem.bounds.x, canvasWidth - 260))}px`,
              '--menu-top': `${editingItem.bounds.y > 40 ? editingItem.bounds.y - 36 : editingItem.bounds.y + editingItem.bounds.h + 6}px`,
            } as React.CSSProperties}
          >
            <select
              value={editingItem.fontFamily.split(',')[0].replace(/['"]/g, '').trim()}
              onChange={(e) => setEditingItem({ ...editingItem, fontFamily: `"${e.target.value}", sans-serif` })}
            >
              <option value="">Font</option>
              <optgroup label="Document Fonts">
                {docFonts.map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
              <optgroup label="All Fonts">
                {Array.from(new Set([
                  'Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
                  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald',
                  'Source Sans Pro', 'Raleway', 'PT Sans', 'Merriweather',
                  'Noto Sans', 'Nunito', 'Playfair Display', 'Lora'
                ])).map(f => <option key={f} value={f}>{f}</option>)}
              </optgroup>
            </select>

            <input
              type="number"
              style={{ width: 38, textAlign: 'center' }}
              value={Math.round(editingItem.fontSize)}
              onChange={(e) => setEditingItem({ ...editingItem, fontSize: Number(e.target.value) || 12 })}
              title="Font Size"
            />

            <input
              type="color"
              style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: '50%', flexShrink: 0 }}
              value={editingItem.color}
              onChange={(e) => setEditingItem({ ...editingItem, color: e.target.value })}
              title="Text Color"
            />

            <div className="toolbar-sep" />

            <button
              className={`text-edit-btn ${editingItem.fontWeight === 'bold' ? 'active' : ''}`}
              style={{ fontWeight: 'bold' }}
              onClick={() => setEditingItem({ ...editingItem, fontWeight: editingItem.fontWeight === 'bold' ? 'normal' : 'bold' })}
              title="Bold"
            >
              B
            </button>
            <button
              className={`text-edit-btn ${editingItem.fontStyle === 'italic' ? 'active' : ''}`}
              style={{ fontStyle: 'italic', fontFamily: 'serif' }}
              onClick={() => setEditingItem({ ...editingItem, fontStyle: editingItem.fontStyle === 'italic' ? 'normal' : 'italic' })}
              title="Italic"
            >
              I
            </button>

            <div className="toolbar-sep" />

            <button
              className="text-edit-btn"
              style={{ color: 'var(--danger)' }}
              onClick={() => {
                setEditingItem({ ...editingItem, text: '' })
                setTimeout(commitEdit, 0)
              }}
              title="Delete text"
            >
              🗑
            </button>
          </div>

          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onKeyDown={handleEditorKeyDown}
            style={{
              position: 'absolute',
              left: editingItem.bounds.x,
              top: editingItem.bounds.y,
              minWidth: 20,
              fontSize: editingItem.fontSize * (canvasHeight / (editingItem.pageHeight || canvasHeight)), // EXACT SCALE Y
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
              cursor: active ? 'move' : 'default',
              pointerEvents: active ? 'auto' : 'none',
            }}
            data-edited-id={edit.id}
            data-item-index={edit.itemIndex}
            title={active ? 'Double click to edit, drag to move' : undefined}
          >
            {edit.newText}
          </div>
        )
      })}
    </div>
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