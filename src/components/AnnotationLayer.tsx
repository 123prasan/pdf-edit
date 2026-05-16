import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { Annotation, Point, ToolType } from '../types'

/* ============================================================
   AnnotationLayer — overlay on top of the PDF canvas
   Handles: selection, drag, resize, text editing, highlight
   drawing, freehand ink, and delete.
   ============================================================ */

type Props = {
  canvasWidth: number
  canvasHeight: number
  annotations: Annotation[]
  tool: ToolType
  page: number
  scale: number
  onAddAnnotation: (a: Annotation) => void
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void
  onDeleteAnnotation: (id: string) => void
  onSelectAnnotation: (id: string | null) => void
  selectedId: string | null
  activeColor?: string | null
}

export default function AnnotationLayer({
  canvasWidth,
  canvasHeight,
  annotations,
  tool,
  page,
  scale,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onSelectAnnotation,
  selectedId,
  activeColor,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Drag state
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    origX: number
    origY: number
  } | null>(null)

  // Resize state
  const resizeRef = useRef<{
    id: string
    startX: number
    startY: number
    origW: number
    origH: number
  } | null>(null)

  // Drawing state (highlight rect or ink path)
  const [inkPreview, setInkPreview] = useState<Point[] | null>(null)
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const drawRef = useRef<{
    type: 'highlight' | 'ink'
    startX: number
    startY: number
    path: Point[]
  } | null>(null)

  // ---- Coordinate helpers ----
  // Returns coordinates in canvas-pixel space (matching canvas dimensions).
  // Since the layer is the same pixel size as the canvas, no scale conversion needed.
  const getLocalCoords = useCallback((e: React.MouseEvent | MouseEvent): Point => {
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    // The layer is rendered at canvasWidth x canvasHeight pixels on screen,
    // so client coords map directly to canvas pixels
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }, [])

  // ---- Global mouse handlers (drag / resize) ----
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { id, startX, startY, origX, origY } = dragRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        onUpdateAnnotation(id, { x: origX + dx, y: origY + dy })
      }
      if (resizeRef.current) {
        const { id, startX, startY, origW, origH } = resizeRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        onUpdateAnnotation(id, {
          width: Math.max(40, origW + dx),
          height: Math.max(20, origH + dy),
        })
      }
    }

    const handleMouseUp = () => {
      dragRef.current = null
      resizeRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [scale, onUpdateAnnotation])

  // ---- Layer-level mouse events (drawing tools) ----
  const handleLayerMouseDown = (e: React.MouseEvent) => {
    // If clicking on an annotation child, don't start drawing
    const target = e.target as HTMLElement
    if (target.closest('.annotation-item') || target.closest('.annotation-delete-btn') || target.closest('.annotation-resize-handle')) return

    const coords = getLocalCoords(e)

    if (tool === 'text') {
      const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
      const newAnn: Annotation = {
        id,
        type: 'text',
        page,
        x: coords.x,
        y: coords.y,
        width: 200,
        height: 60,
        text: '',
        fontSize: 14,
        fontColor: activeColor || '#000000',
        fontStyle: 'normal',
        fontWeight: 'normal',
      }
      onAddAnnotation(newAnn)
      setEditingId(id)
      onSelectAnnotation(id)
    } else if (tool === 'highlight') {
      drawRef.current = { type: 'highlight', startX: coords.x, startY: coords.y, path: [] }
      setHighlightPreview({ x: coords.x, y: coords.y, w: 0, h: 0 })
    } else if (tool === 'ink') {
      drawRef.current = { type: 'ink', startX: coords.x, startY: coords.y, path: [coords] }
      setInkPreview([coords])
    } else if (tool === 'select') {
      onSelectAnnotation(null)
    }
  }

  const handleLayerMouseMove = (e: React.MouseEvent) => {
    if (!drawRef.current) return
    const coords = getLocalCoords(e)

    if (drawRef.current.type === 'ink') {
      drawRef.current.path.push(coords)
      setInkPreview([...drawRef.current.path])
    } else if (drawRef.current.type === 'highlight') {
      const d = drawRef.current
      const x = Math.min(d.startX, coords.x)
      const y = Math.min(d.startY, coords.y)
      const w = Math.abs(coords.x - d.startX)
      const h = Math.abs(coords.y - d.startY)
      setHighlightPreview({ x, y, w, h })
    }
  }

  const handleLayerMouseUp = (e: React.MouseEvent) => {
    const d = drawRef.current
    if (!d) return
    const coords = getLocalCoords(e)

    if (d.type === 'highlight') {
      const x = Math.min(d.startX, coords.x)
      const y = Math.min(d.startY, coords.y)
      const w = Math.abs(coords.x - d.startX)
      const h = Math.abs(coords.y - d.startY)
      if (w > 5 && h > 5) {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
        onAddAnnotation({
          id,
          type: 'highlight',
          page,
          x,
          y,
          width: w,
          height: h,
          color: '#fbbf24',
          opacity: 0.3,
        })
      }
      setHighlightPreview(null)
    } else if (d.type === 'ink') {
      if (d.path.length > 2) {
        // Compute bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of d.path) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
        }
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
        onAddAnnotation({
          id,
          type: 'ink',
          page,
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
          path: d.path,
          fontColor: '#818cf8',
        })
      }
      setInkPreview(null)
    }

    drawRef.current = null
  }

  // ---- Annotation item handlers ----
  const handleAnnotationMouseDown = (e: React.MouseEvent, ann: Annotation) => {
    if (tool !== 'select') return
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return

    onSelectAnnotation(ann.id)
    dragRef.current = {
      id: ann.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: ann.x,
      origY: ann.y,
    }
    e.stopPropagation()
    e.preventDefault()
  }

  const handleResizeMouseDown = (e: React.MouseEvent, ann: Annotation) => {
    e.stopPropagation()
    e.preventDefault()
    resizeRef.current = {
      id: ann.id,
      startX: e.clientX,
      startY: e.clientY,
      origW: ann.width,
      origH: ann.height,
    }
  }

  const handleDoubleClick = (ann: Annotation) => {
    if (ann.type === 'text') {
      setEditingId(ann.id)
    }
  }

  const cursorStyle = tool === 'text' ? 'crosshair'
    : tool === 'highlight' ? 'crosshair'
      : tool === 'ink' ? 'crosshair'
        : tool === 'pan' ? 'grab'
          : tool === 'edit' ? 'text'
            : 'default'

  // When edit tool is active, let the TextEditLayer handle events
  const isEditMode = tool === 'edit'

  return (
    <div
      ref={layerRef}
      className="annotation-layer"
      style={{
        width: canvasWidth,
        height: canvasHeight,
        cursor: cursorStyle,
        pointerEvents: isEditMode ? 'none' : 'auto',
      }}
      onMouseDown={handleLayerMouseDown}
      onMouseMove={handleLayerMouseMove}
      onMouseUp={handleLayerMouseUp}
    >
      {/* Highlight preview while drawing */}
      {highlightPreview && (
        <div
          style={{
            position: 'absolute',
            left: highlightPreview.x,
            top: highlightPreview.y,
            width: highlightPreview.w,
            height: highlightPreview.h,
            background: 'rgba(251, 191, 36, 0.25)',
            border: '2px dashed rgba(251, 191, 36, 0.6)',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Ink preview while drawing */}
      {inkPreview && inkPreview.length > 1 && (
        <svg
          className="ink-preview-svg"
          width={canvasWidth}
          height={canvasHeight}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
        >
          <polyline
            points={inkPreview.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="rgba(129, 140, 248, 0.7)"
            strokeWidth={2.5 / scale}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}

      {/* Rendered annotations */}
      {annotations.map(ann => {
        const isSelected = selectedId === ann.id
        const isEditing = editingId === ann.id

        if (ann.type === 'text') {
          // Build chars array from text if not present
          const chars = ann.chars || (ann.text ? ann.text.split('').map(char => ({
            char,
            fontSize: ann.fontSize || 14,
            fontColor: ann.fontColor || '#000000',
            fontStyle: ann.fontStyle || 'normal',
            fontWeight: ann.fontWeight || 'normal',
          })) : [])

          return (
            <div
              key={ann.id}
              className={`annotation-item annotation-text-box ${isEditing ? 'editing' : ''} ${isSelected ? 'selected' : ''}`}
              style={{
                left: ann.x,
                top: ann.y,
                width: ann.width,
                height: ann.height,
                fontSize: ann.fontSize || 14,
                color: ann.fontColor || '#000000',
                fontStyle: ann.fontStyle || 'normal',
                fontWeight: ann.fontWeight || 'normal',
              }}
              onMouseDown={(e) => handleAnnotationMouseDown(e, ann)}
              onDoubleClick={() => handleDoubleClick(ann)}
            >
              {isEditing ? (
                <div
                  className="annotation-contenteditable"
                  contentEditable
                  suppressContentEditableWarning
                  autoFocus
                  onInput={(e) => {
                    const text = e.currentTarget.innerText || ''
                    const prevChars = ann.chars || []
                    const lastChar = prevChars[prevChars.length - 1]
                    const newChars = text.split('').map(char => ({
                      char,
                      fontSize: lastChar?.fontSize || ann.fontSize || 14,
                      fontColor: lastChar?.fontColor || ann.fontColor || '#000000',
                      fontStyle: lastChar?.fontStyle || ann.fontStyle || 'normal',
                      fontWeight: lastChar?.fontWeight || ann.fontWeight || 'normal',
                    }))
                    onUpdateAnnotation(ann.id, { text, chars: newChars })
                  }}
                  onBlur={() => setEditingId(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.currentTarget.blur()
                      setEditingId(null)
                    }
                  }}
                  style={{
                    fontSize: ann.fontSize || 14,
                    color: ann.fontColor || '#000000',
                    fontStyle: ann.fontStyle || 'normal',
                    fontWeight: ann.fontWeight || 'normal',
                  }}
                />
              ) : (
                <div className="annotation-text-display" style={{
                  fontSize: ann.fontSize || 14,
                  color: ann.fontColor || '#000000',
                  fontStyle: ann.fontStyle || 'normal',
                  fontWeight: ann.fontWeight || 'normal',
                }}>
                  {chars.length > 0 ? (
                    chars.map((c, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: c.fontSize,
                          color: c.fontColor,
                          fontStyle: c.fontStyle,
                          fontWeight: c.fontWeight,
                          display: 'inline',
                        }}
                      >
                        {c.char === '\n' ? <br /> : c.char}
                      </span>
                    ))
                  ) : (
                    <span>Double-click to edit</span>
                  )}
                </div>
              )}
              {(isSelected || true) && (
                <button
                  className="annotation-delete-btn"
                  onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(ann.id) }}
                  title="Delete"
                >
                  ×
                </button>
              )}
              <div
                className="annotation-resize-handle"
                onMouseDown={(e) => handleResizeMouseDown(e, ann)}
              />
            </div>
          )
        }

        if (ann.type === 'highlight') {
          return (
            <div
              key={ann.id}
              className={`annotation-item annotation-highlight ${isSelected ? 'selected' : ''}`}
              style={{
                left: ann.x,
                top: ann.y,
                width: ann.width,
                height: ann.height,
                background: `${ann.color || '#fbbf24'}${Math.round((ann.opacity ?? 0.3) * 255).toString(16).padStart(2, '0')}`,
              }}
              onMouseDown={(e) => handleAnnotationMouseDown(e, ann)}
            >
              <button
                className="annotation-delete-btn"
                onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(ann.id) }}
                title="Delete"
              >
                ×
              </button>
              <div
                className="annotation-resize-handle"
                onMouseDown={(e) => handleResizeMouseDown(e, ann)}
              />
            </div>
          )
        }

        if (ann.type === 'ink' && ann.path && ann.path.length > 1) {
          return (
            <div
              key={ann.id}
              className={`annotation-item annotation-ink ${isSelected ? 'selected' : ''}`}
              style={{ left: 0, top: 0, width: canvasWidth, height: canvasHeight, pointerEvents: 'none' }}
            >
              <svg width={canvasWidth} height={canvasHeight} style={{ overflow: 'visible' }}>
                {/* Wider invisible stroke for easier click selection */}
                <polyline
                  points={ann.path.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ pointerEvents: 'stroke', cursor: tool === 'select' ? 'move' : 'default' }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    handleAnnotationMouseDown(e as any, ann)
                  }}
                />
                <polyline
                  points={ann.path.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={ann.fontColor || '#818cf8'}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  style={{ pointerEvents: 'none' }}
                />
              </svg>
              <button
                className="annotation-delete-btn"
                style={{ top: Math.min(...ann.path.map(p => p.y)) - 14, left: Math.max(...ann.path.map(p => p.x)) + 4, pointerEvents: 'auto' }}
                onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(ann.id) }}
                title="Delete"
              >
                ×
              </button>
            </div>
          )
        }

        return null
      })}
    </div>
  )
}
