import React, { useRef, useState, useEffect } from 'react'
import { Box, Button, ToggleButton, ToggleButtonGroup } from '@mui/material'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf'
import AnnotationLayer, { Annotation } from './AnnotationLayer'
import { exportPdfWithAnnotations } from '../utils/pdfUtils'

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${(pdfjsLib as any).version}/pdf.worker.min.js`;

export default function PDFViewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
  const [viewport, setViewport] = useState<any>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [tool, setTool] = useState<'select' | 'text' | 'pan' | 'highlight' | 'ink'>('select')
  const [currentPage, setCurrentPage] = useState<number>(1)

  useEffect(() => {
    const handleResize = () => {
      // re-render page on resize if needed
      if (pdfBytes) {
        // re-open file to re-render - simple approach: reload first page
        const load = async () => {
          const loadingTask = pdfjsLib.getDocument({ data: pdfBytes })
          const pdf = await loadingTask.promise
          const page = await pdf.getPage(currentPage)
          const vp = page.getViewport({ scale: 1.5 })
          setViewport(vp)
          const canvas = canvasRef.current
          if (!canvas) return
          const context = canvas.getContext('2d')!
          canvas.height = vp.height
          canvas.width = vp.width
          await page.render({ canvasContext: context, viewport: vp }).promise
        }
        load()
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [pdfBytes])

  // render current page when page number changes
  useEffect(() => {
    const loadPage = async () => {
      if (!pdfBytes) return
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes })
      const pdf = await loadingTask.promise
      const page = await pdf.getPage(currentPage)
      const vp = page.getViewport({ scale: 1.5 })
      setViewport(vp)
      const canvas = canvasRef.current
      if (!canvas) return
      const context = canvas.getContext('2d')!
      canvas.height = vp.height
      canvas.width = vp.width
      await page.render({ canvasContext: context, viewport: vp }).promise
    }
    loadPage()
  }, [pdfBytes, currentPage])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    setPdfBytes(bytes)
    const loadingTask = pdfjsLib.getDocument({ data: bytes })
    const pdf = await loadingTask.promise
    setNumPages(pdf.numPages)
    const page = await pdf.getPage(1)
    const vp = page.getViewport({ scale: 1.5 })
    setViewport(vp)
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')!
    canvas.height = vp.height
    canvas.width = vp.width
    await page.render({ canvasContext: context, viewport: vp }).promise
    // reset annotations when new file loaded
    setAnnotations([])
  }

  const handleAddText = (x: number, y: number) => {
    const id = Date.now().toString()
    const newAnn: Annotation = { id, type: 'text', page: currentPage, x, y, width: 160, height: 40, text: 'New text', editing: true }
    setAnnotations(prev => [...prev, newAnn])
  }

  const handleAddAnnotation = (ann: Annotation) => {
    setAnnotations(prev => [...prev, ann])
  }

  const handleUpdate = (id: string, patch: Partial<Annotation>) => {
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a))
  }

  const handleExport = async () => {
    if (!pdfBytes) return
    const newPdfBytes = await exportPdfWithAnnotations(pdfBytes, annotations)
    const blob = new Blob([newPdfBytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'annotated.pdf'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Box>
      <input id="file" type="file" accept="application/pdf" onChange={handleFile} />
      <Box sx={{ mt: 2, display: 'flex', gap: 1, alignItems: 'center' }}>
        <ToggleButtonGroup
          value={tool}
          exclusive
          onChange={(_, v) => v && setTool(v)}
          size="small"
        >
          <ToggleButton value="select">Select</ToggleButton>
          <ToggleButton value="text">Add Text</ToggleButton>
          <ToggleButton value="highlight">Highlight</ToggleButton>
          <ToggleButton value="ink">Freehand</ToggleButton>
          <ToggleButton value="pan">Pan</ToggleButton>
        </ToggleButtonGroup>
        <Button variant="contained" onClick={handleExport}>Export PDF</Button>
        <Box sx={{ ml: 2, display: 'flex', gap: 1 }}>
          <Button disabled={currentPage <= 1} onClick={() => setCurrentPage(p => Math.max(1, p - 1))}>Prev</Button>
          <Button disabled={currentPage >= numPages} onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}>Next</Button>
        </Box>
      </Box>

      <Box ref={containerRef} className="canvasContainer" sx={{ mt: 2, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ display: 'block' }} />
        {viewport && (
          <AnnotationLayer
            viewport={viewport}
            annotations={annotations.filter(a => a.page === currentPage)}
            tool={tool}
            page={currentPage}
            onAddAnnotation={(a: Annotation) => handleAddAnnotation(a)}
            onAddText={(x: number, y: number) => handleAddText(x, y)}
            onUpdate={handleUpdate}
            containerRef={containerRef}
          />
        )}
      </Box>
    </Box>
  )
}
