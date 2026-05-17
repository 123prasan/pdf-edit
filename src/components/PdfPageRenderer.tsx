import React, { useEffect, useRef, useState } from 'react'
import AnnotationLayer from './AnnotationLayer'
import TextEditLayer from './TextEditLayer'

interface Props {
  pdfDoc: any
  pageNumber: number
  totalPages: number
  scale: number
  tool: string
  activeColor: string | null
  activeFont: string | null
  setActiveColor: (c: string) => void
  setActiveFont: (c: string) => void
  docFonts: string[]
  docColors: string[]
  extractedItems: any
  annotations: any[]
  textEdits: any[]
  selectedId: string | null
  onAddAnnotation: (a: any) => void
  onUpdateAnnotation: (id: string, updates: any) => void
  onDeleteAnnotation: (id: string) => void
  onSelectAnnotation: (id: string | null) => void
  onTextEdit: (edit: any) => void
  onDeletePage: (pageNum: number) => void
  onRotatePage: (pageNum: number, angle: number) => void
  onInsertBlankPage: (beforePageNum: number) => void
}

export default function PdfPageRenderer({
  pdfDoc, pageNumber, totalPages, scale, tool, activeColor, activeFont, setActiveColor, setActiveFont,
  docFonts, docColors, extractedItems, annotations, textEdits, selectedId,
  onAddAnnotation, onUpdateAnnotation, onDeleteAnnotation, onSelectAnnotation, onTextEdit,
  onDeletePage, onRotatePage, onInsertBlankPage
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const renderTaskRef = useRef<any>(null)
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [pdfViewport, setPdfViewport] = useState<any>(null)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const [isVisible, setIsVisible] = useState(false)

  // Lazy loading observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '500px 0px' } // Load slightly before it comes into view
    )

    if (wrapperRef.current) {
      observer.observe(wrapperRef.current)
    }

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isVisible) return
    let isCancelled = false
    const renderPage = async () => {
      if (!pdfDoc) return

      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch (_) { }
      }

      try {
        const page = await pdfDoc.getPage(pageNumber)
        if (isCancelled) return
        const vp = page.getViewport({ scale })
        setCanvasWidth(vp.width)
        setCanvasHeight(vp.height)
        setPdfPage(page)
        setPdfViewport(vp)

        const canvas = canvasRef.current
        if (!canvas) return

        // Use devicePixelRatio * 2 for ultra-crisp rendering on Retina/mobile screens
        const pixelRatio = (window.devicePixelRatio || 1) * 2
        canvas.width = Math.floor(vp.width * pixelRatio)
        canvas.height = Math.floor(vp.height * pixelRatio)
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        ctx.fillText = function () { }
        ctx.strokeText = function () { }

        const transform = pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : null

        const task = page.render({
          canvasContext: ctx,
          viewport: vp,
          transform: transform || undefined
        })
        renderTaskRef.current = task
        await task.promise
        renderTaskRef.current = null
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return
      }
    }
    renderPage()

    return () => {
      isCancelled = true
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch (_) { }
      }
    }
  }, [pdfDoc, pageNumber, scale, isVisible])

  // Use an estimated height until rendered to maintain scroll position
  const estimatedHeight = canvasHeight || (1000 * (scale / 1.25))
  const estimatedWidth = canvasWidth || (800 * (scale / 1.25))

  return (
    <div style={{ marginBottom: '24px', position: 'relative' }}>
      {/* Page Actions Bar */}
      <div className="page-actions-bar">
        <span className="page-actions-label">Page {pageNumber}</span>
        <div className="page-actions-btns">
          <button
            className="page-action-btn"
            title="Insert blank page before"
            onClick={() => onInsertBlankPage(pageNumber)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </button>
          <button
            className="page-action-btn"
            title="Rotate left"
            onClick={() => onRotatePage(pageNumber, -90)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
          <button
            className="page-action-btn"
            title="Rotate right"
            onClick={() => onRotatePage(pageNumber, 90)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
            </svg>
          </button>
          <button
            className="page-action-btn page-action-btn--danger"
            title={totalPages <= 1 ? "Can't delete the only page" : "Delete this page"}
            disabled={totalPages <= 1}
            onClick={() => onDeletePage(pageNumber)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Canvas Wrapper */}
      <div
        ref={wrapperRef}
        className="canvas-wrapper"
        style={{
          width: estimatedWidth,
          height: estimatedHeight,
          background: 'white'
        }}
      >
        {isVisible && (
          <canvas ref={canvasRef} style={{ display: 'block', width: canvasWidth || '100%', height: canvasHeight || '100%' }} />
        )}
        <AnnotationLayer
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          annotations={annotations}
          tool={tool}
          page={pageNumber}
          scale={scale}
          activeColor={activeColor}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onDeleteAnnotation={onDeleteAnnotation}
          onSelectAnnotation={onSelectAnnotation}
          selectedId={selectedId}
        />
        {pdfPage && pdfViewport && (
          <TextEditLayer
            pdfPage={pdfPage}
            viewport={pdfViewport}
            scale={scale}
            page={pageNumber}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            canvasRef={canvasRef}
            textEdits={textEdits}
            onTextEdit={onTextEdit}
            tool={tool}
            extractedItems={extractedItems}
            activeColor={activeColor}
            activeFont={activeFont}
            setActiveColor={setActiveColor}
            setActiveFont={setActiveFont}
            docFonts={docFonts}
            docColors={docColors}
          />
        )}
      </div>
    </div>
  )
}
