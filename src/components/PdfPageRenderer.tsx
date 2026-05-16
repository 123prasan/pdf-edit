import React, { useEffect, useRef, useState } from 'react'
import AnnotationLayer from './AnnotationLayer'
import TextEditLayer from './TextEditLayer'

interface Props {
  pdfDoc: any
  pageNumber: number
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
}

export default function PdfPageRenderer({
  pdfDoc, pageNumber, scale, tool, activeColor, activeFont, setActiveColor, setActiveFont,
  docFonts, docColors, extractedItems, annotations, textEdits, selectedId,
  onAddAnnotation, onUpdateAnnotation, onDeleteAnnotation, onSelectAnnotation, onTextEdit
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
    <div
      ref={wrapperRef}
      className="canvas-wrapper"
      style={{
        width: estimatedWidth,
        height: estimatedHeight,
        marginBottom: '24px',
        background: 'white' // Shows a white placeholder while loading
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
  )
}
