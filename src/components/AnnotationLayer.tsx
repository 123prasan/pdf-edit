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
    width: number
    height: number
  } | null>(null)

  // Resize state
  const resizeRef = useRef<{
    id: string
    startX: number
    startY: number
    origW: number
    origH: number
  } | null>(null)

  // Drawing state (highlight rect or ink path or shapes)
  const [inkPreview, setInkPreview] = useState<Point[] | null>(null)
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [shapePreview, setShapePreview] = useState<{ type: string; x: number; y: number; w: number; h: number; x2?: number; y2?: number } | null>(null)
  const drawRef = useRef<{
    type: 'highlight' | 'ink' | 'rect' | 'ellipse' | 'line'
    startX: number
    startY: number
    path: Point[]
  } | null>(null)

  // Returns coordinates in canvas-pixel space (matching canvas dimensions).
  // Since the layer is the same pixel size as the canvas, no scale conversion needed.
  const getLocalCoords = useCallback((e: React.MouseEvent | MouseEvent): Point => {
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    
    // Clamp coordinates to ensure drawings never go outside the PDF bounds
    const x = Math.max(0, Math.min(e.clientX - rect.left, canvasWidth))
    const y = Math.max(0, Math.min(e.clientY - rect.top, canvasHeight))
    
    return { x, y }
  }, [canvasWidth, canvasHeight])

  // ---- Global mouse handlers (drag / resize) ----
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { id, startX, startY, origX, origY, width, height } = dragRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        
        let newX = origX + dx
        let newY = origY + dy
        
        // Use actual shape dimensions to prevent any part from crossing the edge.
        // Add slight padding to ensure delete/resize buttons don't clip off either.
        const clampW = width || 0
        const clampH = height || 0
        newX = Math.max(0, Math.min(newX, canvasWidth - clampW - 10))
        newY = Math.max(0, Math.min(newY, canvasHeight - clampH - 10))
        
        onUpdateAnnotation(id, { x: newX, y: newY })
      }
      if (resizeRef.current) {
        const { id, startX, startY, origW, origH } = resizeRef.current
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        onUpdateAnnotation(id, {
          width: Math.max(20, Math.min(origW + dx, canvasWidth)),
          height: Math.max(20, Math.min(origH + dy, canvasHeight)),
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
  }, [scale, onUpdateAnnotation, canvasWidth, canvasHeight])

  // ---- Layer-level mouse events (drawing tools) ----
  const handleLayerMouseDown = (e: React.MouseEvent) => {
    // If clicking on an annotation child, don't start drawing
    const target = e.target as HTMLElement
    if (target.closest('.annotation-item') || target.closest('.annotation-delete-btn') || target.closest('.annotation-resize-handle')) return

    const coords = getLocalCoords(e)

    if (tool === 'highlight') {
      drawRef.current = { type: 'highlight', startX: coords.x, startY: coords.y, path: [] }
      setHighlightPreview({ x: coords.x, y: coords.y, w: 0, h: 0 })
    } else if (tool === 'ink') {
      drawRef.current = { type: 'ink', startX: coords.x, startY: coords.y, path: [coords] }
      setInkPreview([coords])
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'line') {
      drawRef.current = { type: tool, startX: coords.x, startY: coords.y, path: [] }
      setShapePreview({ type: tool, x: coords.x, y: coords.y, w: 0, h: 0, x2: coords.x, y2: coords.y })
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
    } else if (drawRef.current.type === 'rect' || drawRef.current.type === 'ellipse') {
      const d = drawRef.current
      const x = Math.min(d.startX, coords.x)
      const y = Math.min(d.startY, coords.y)
      const w = Math.abs(coords.x - d.startX)
      const h = Math.abs(coords.y - d.startY)
      setShapePreview({ type: d.type, x, y, w, h })
    } else if (drawRef.current.type === 'line') {
      const d = drawRef.current
      setShapePreview({ type: d.type, x: d.startX, y: d.startY, w: 0, h: 0, x2: coords.x, y2: coords.y })
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
          fontColor: activeColor || '#818cf8',
        })
      }
      setInkPreview(null)
    } else if (d.type === 'rect' || d.type === 'ellipse') {
      const w = Math.abs(coords.x - d.startX)
      const h = Math.abs(coords.y - d.startY)
      if (w > 5 && h > 5) {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
        onAddAnnotation({
          id,
          type: d.type,
          page,
          x: Math.min(d.startX, coords.x),
          y: Math.min(d.startY, coords.y),
          width: w,
          height: h,
          strokeColor: activeColor || '#000000',
          strokeWidth: 2,
          fillColor: 'transparent',
        })
      }
      setShapePreview(null)
    } else if (d.type === 'line') {
      const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()
      onAddAnnotation({
        id,
        type: 'line',
        page,
        x: d.startX,
        y: d.startY,
        width: 0,
        height: 0,
        x2: coords.x,
        y2: coords.y,
        strokeColor: activeColor || '#000000',
        strokeWidth: 2,
      })
      setShapePreview(null)
    }

    drawRef.current = null
  }

  // ---- Annotation item handlers ----
  const handleAnnotationMouseDown = (e: React.MouseEvent, ann: Annotation) => {
    if (tool !== 'select') return
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return

    onSelectAnnotation(ann.id)
    
    // For lines, width is max(abs(x2-x)), for others it's just ann.width
    const effectiveWidth = ann.type === 'line' ? Math.max(Math.abs((ann.x2 || 0) - ann.x), 2) : ann.width
    const effectiveHeight = ann.type === 'line' ? Math.max(Math.abs((ann.y2 || 0) - ann.y), 2) : ann.height

    dragRef.current = {
      id: ann.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: ann.x,
      origY: ann.y,
      width: effectiveWidth,
      height: effectiveHeight
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
        touchAction: 'auto',
      }}
      onMouseDown={handleLayerMouseDown}
      onMouseMove={handleLayerMouseMove}
      onMouseUp={handleLayerMouseUp}
      onMouseLeave={handleLayerMouseUp}
    >
      {/* HIGHLIGHT PREVIEW */}
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

      {/* INK PREVIEW */}
      {inkPreview && inkPreview.length > 1 && (
        <svg style={{ position: 'absolute', top: 0, left: 0, width: canvasWidth, height: canvasHeight, pointerEvents: 'none' }}>
          <polyline
            points={inkPreview.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={activeColor || '#818cf8'}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}

      {/* SHAPE PREVIEWS */}
      {shapePreview && shapePreview.type === 'rect' && (
        <div style={{
          position: 'absolute', left: shapePreview.x, top: shapePreview.y,
          width: shapePreview.w, height: shapePreview.h,
          border: `2px solid ${activeColor || '#000'}`, pointerEvents: 'none'
        }} />
      )}
      {shapePreview && shapePreview.type === 'ellipse' && (
        <div style={{
          position: 'absolute', left: shapePreview.x, top: shapePreview.y,
          width: shapePreview.w, height: shapePreview.h,
          border: `2px solid ${activeColor || '#000'}`, borderRadius: '50%', pointerEvents: 'none'
        }} />
      )}
      {shapePreview && shapePreview.type === 'line' && (
        <svg style={{ position: 'absolute', top: 0, left: 0, width: canvasWidth, height: canvasHeight, pointerEvents: 'none' }}>
          <line
            x1={shapePreview.x}
            y1={shapePreview.y}
            x2={shapePreview.x2}
            y2={shapePreview.y2}
            stroke={activeColor || '#000'}
            strokeWidth={2}
          />
        </svg>
      )}

      {/* RENDERED ANNOTATIONS */}
      {annotations.map(ann => {
        const isSelected = selectedId === ann.id

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

        if (ann.type === 'rect' || ann.type === 'ellipse' || ann.type === 'line') {
          return (
            <div
              key={ann.id}
              className={`annotation-item ${isSelected ? 'selected' : ''}`}
              style={{
                left: ann.type === 'line' ? Math.min(ann.x, ann.x2!) : ann.x,
                top: ann.type === 'line' ? Math.min(ann.y, ann.y2!) : ann.y,
                width: ann.type === 'line' ? Math.max(Math.abs(ann.x2! - ann.x), 2) : ann.width,
                height: ann.type === 'line' ? Math.max(Math.abs(ann.y2! - ann.y), 2) : ann.height,
              }}
              onMouseDown={(e) => handleAnnotationMouseDown(e, ann)}
            >
              <svg style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
                {ann.type === 'rect' && (
                  <rect
                    x={0} y={0}
                    width={ann.width} height={ann.height}
                    fill={ann.fillColor === 'transparent' ? 'none' : ann.fillColor}
                    stroke={ann.strokeColor || '#000'}
                    strokeWidth={ann.strokeWidth || 2}
                  />
                )}
                {ann.type === 'ellipse' && (
                  <ellipse
                    cx={ann.width / 2} cy={ann.height / 2}
                    rx={Math.max(0, ann.width / 2 - (ann.strokeWidth || 2) / 2)}
                    ry={Math.max(0, ann.height / 2 - (ann.strokeWidth || 2) / 2)}
                    fill={ann.fillColor === 'transparent' ? 'none' : ann.fillColor}
                    stroke={ann.strokeColor || '#000'}
                    strokeWidth={ann.strokeWidth || 2}
                  />
                )}
                {ann.type === 'line' && (
                  <line
                    x1={ann.x < ann.x2! ? 0 : Math.abs(ann.x2! - ann.x)}
                    y1={ann.y < ann.y2! ? 0 : Math.abs(ann.y2! - ann.y)}
                    x2={ann.x < ann.x2! ? Math.abs(ann.x2! - ann.x) : 0}
                    y2={ann.y < ann.y2! ? Math.abs(ann.y2! - ann.y) : 0}
                    stroke={ann.strokeColor || '#000'}
                    strokeWidth={ann.strokeWidth || 2}
                    strokeLinecap="round"
                  />
                )}
              </svg>
              {isSelected && (
                <button
                  className="annotation-delete-btn"
                  onClick={(e) => { e.stopPropagation(); onDeleteAnnotation(ann.id) }}
                >
                  ×
                </button>
              )}
              {isSelected && ann.type !== 'line' && (
                <div
                  className="annotation-resize-handle"
                  onMouseDown={(e) => handleResizeMouseDown(e, ann)}
                />
              )}
            </div>
          )
        }

        return null
      })}
    </div>
  )
}
