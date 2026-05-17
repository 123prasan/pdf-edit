import React, { useState, useRef, useCallback, useEffect } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf'
import { PDFDocument } from 'pdf-lib'
import type { TextEdit } from './components/TextEditLayer'
import PdfPageRenderer from './components/PdfPageRenderer'
import {
  IconUpload, IconDownload, IconCursor, IconEdit, IconType, IconHighlighter,
  IconPen, IconHand, IconChevronLeft,
  IconChevronRight, IconTrash, IconUndo, IconRedo, IconPDF,
  IconPlus, IconMinus, IconFile, IconSquare, IconCircle, IconLine
} from './components/Icons'
import type { Annotation, ToolType } from './types'
import { useExtractedText } from './hooks/useExtractedText'

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${(pdfjsLib as any).version}/pdf.worker.min.js`

/* ============================================================
   AdSlot — reusable Google AdSense ad unit
   Replace data-ad-slot values with your actual AdSense slot IDs
   ============================================================ */
declare global {
  interface Window { adsbygoogle: any[] }
}

function AdSlot({ format = 'auto', slot, className = '', layoutKey }: { format?: string; slot: string; className?: string; layoutKey?: string }) {
  const adRef = React.useRef<HTMLDivElement>(null)
  const pushed = React.useRef(false)
  React.useEffect(() => {
    if (pushed.current) return
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({})
      pushed.current = true
    } catch (e) { /* adblock or no adsense */ }
  }, [])
  return (
    <div ref={adRef} className={`ad-slot ${className}`}>
      <ins className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client="ca-pub-3321203820490717"
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive="true"
        {...(layoutKey ? { 'data-ad-layout-key': layoutKey } : {})}
      />
    </div>
  )
}

/* ============================================================
   ExportInterstitial — 5-second fullscreen ad after export
   ============================================================ */
function ExportInterstitial({ onClose, pendingDownload }: { onClose: () => void, pendingDownload: { url: string, filename: string } | null }) {
  const [countdown, setCountdown] = React.useState(5)
  const hasDownloaded = React.useRef(false)

  React.useEffect(() => {
    if (countdown > 0) {
      const t = setTimeout(() => setCountdown(c => c - 1), 1000)
      return () => clearTimeout(t)
    } else if (!hasDownloaded.current && pendingDownload) {
      // Countdown finished! Trigger the download now
      const a = document.createElement('a')
      a.href = pendingDownload.url
      a.download = pendingDownload.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      hasDownloaded.current = true
    }
  }, [countdown, pendingDownload])

  return (
    <div className="interstitial-overlay">
      <div className="interstitial-card">
        <div className="interstitial-header">
          <span className="interstitial-badge">✓ PDF Ready!</span>
          {countdown <= 0 ? (
            <button className="btn-primary interstitial-close" onClick={onClose}>Continue Editing</button>
          ) : (
            <span className="interstitial-timer">Downloading in {countdown}s</span>
          )}
        </div>
        <div className="interstitial-ad">
          <AdSlot slot="8578929833" format="rectangle" className="ad-interstitial" />
        </div>
        <p className="interstitial-hint">
          {countdown <= 0 ? "Your edited PDF has been downloaded." : "Please wait while we prepare your file..."}
        </p>
      </div>
    </div>
  )
}

/* ============================================================
   PdfLoadingStep — animated step indicator used in loading overlay
   ============================================================ */
function PdfLoadingStep({ text, delay }: { text: string; delay: number }) {
  const [active, setActive] = React.useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setActive(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return (
    <div className={`pdf-loading-step ${active ? 'active' : ''}`}>
      <div className="pdf-loading-step-dot">
        {active && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5l2.5 2.5L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <span>{text}</span>
    </div>
  )
}

/* ============================================================
   PDF Studio — Enterprise PDF Editor
   ============================================================ */

export default function App() {
  // ---- State ----
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
  const [pdfFileObj, setPdfFileObj] = useState<File | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.25)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const [tool, setTool] = useState<ToolType>('select')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toastMsg, setToastMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [textEdits, setTextEdits] = useState<TextEdit[]>([])
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [pdfViewport, setPdfViewport] = useState<any>(null)
  const [docColors, setDocColors] = useState<string[]>([])
  const [docFonts, setDocFonts] = useState<string[]>([])
  const [activeColor, setActiveColor] = useState<string | null>(null)
  const [activeFont, setActiveFont] = useState<string | null>(null)
  const [showColorPicker, setShowColorPicker] = useState(false)

  const STANDARD_COLORS = [
    '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
    '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
    '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#CFE2F3', '#D9D2E9', '#EAD1DC',
  ]

  const { data: extractedItems, embeddedFonts, loading: extractLoading } = useExtractedText(pdfFileObj)

  // Inject embedded fonts from PDF
  useEffect(() => {
    if (embeddedFonts && Object.keys(embeddedFonts).length > 0) {
      const existing = document.getElementById('pdf-embedded-fonts')
      if (existing) existing.remove()
      const style = document.createElement('style')
      style.id = 'pdf-embedded-fonts'
      style.textContent = Object.entries(embeddedFonts).map(([fontName, dataUrl]) => {
        const cssName = fontName.replace(/^[A-Z]{6}\+/, '')
        const lower = cssName.toLowerCase()
        const fw = (lower.includes('bold') || lower.includes('black') || lower.includes('heavy') || lower.includes('semibold')) ? 'bold' : 'normal'
        const fs = (lower.includes('italic') || lower.includes('oblique') || lower.includes('slanted') || lower.endsWith('it')) ? 'italic' : 'normal'
        return `@font-face { font-family: "${cssName}"; src: url("${dataUrl}"); font-weight: ${fw}; font-style: ${fs}; }`
      }).join('\n')
      document.head.appendChild(style)
    }
  }, [embeddedFonts])

  // Inject Google Fonts for Fallbacks & Extract Document Palette
  useEffect(() => {
    if (!extractedItems) return
    const gFonts = new Set<string>()
    const cSet = new Set<string>()
    const fSet = new Set<string>()
    const knownGFonts = [
      'Montserrat', 'Poppins', 'Inter', 'Raleway', 'Oswald', 'Roboto',
      'Open Sans', 'Lato', 'Nunito', 'Work Sans', 'Rubik', 'Merriweather',
      'Playfair Display', 'Lora', 'Source Sans Pro', 'Source Sans 3',
      'Noto Sans', 'Fira Sans', 'Karla', 'Heebo', 'Hind', 'PT Sans',
      'EB Garamond', 'PT Serif', 'Bree Serif', 'Arvo'
    ]

    Object.values(extractedItems).forEach(pageItems => {
      pageItems.forEach((item: any) => {
        if (item.color) cSet.add(item.color.toUpperCase())
        if (!item.fontFamily) return
        const firstFont = item.fontFamily.split(',')[0].replace(/['"]/g, '').trim()
        fSet.add(firstFont)
        if (knownGFonts.includes(firstFont)) {
          gFonts.add(firstFont.replace(/ /g, '+'))
        }
      })
    })

    const uniqueColors = Array.from(cSet).slice(0, 8)
    const uniqueFonts = Array.from(fSet).slice(0, 5)
    setDocColors(uniqueColors)
    setDocFonts(uniqueFonts)
    if (uniqueColors.length > 0 && !activeColor) setActiveColor(uniqueColors[0])
    if (uniqueFonts.length > 0 && !activeFont) setActiveFont(uniqueFonts[0])

    if (gFonts.size > 0) {
      const familyQuery = Array.from(gFonts).map(f => `family=${f}:ital,wght@0,400;0,700;1,400;1,700`).join('&')
      const url = `https://fonts.googleapis.com/css2?${familyQuery}&display=swap`

      const existing = document.getElementById('google-fonts-dynamic')
      if (existing) existing.remove()

      const link = document.createElement('link')
      link.id = 'google-fonts-dynamic'
      link.rel = 'stylesheet'
      link.href = url
      document.head.appendChild(link)
    }
  }, [extractedItems])

  // Undo / Redo
  const [history, setHistory] = useState<Annotation[][]>([[]])
  const [historyIndex, setHistoryIndex] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pdfDocRef = useRef<any>(null)
  const pdfBytesRef = useRef<Uint8Array | null>(null)  // ref mirror for export
  const renderTaskRef = useRef<any>(null)               // track current render task
  const isDraggingRef = useRef(false)                    // track if we're in a drag/resize
  const [pdfReady, setPdfReady] = useState(0)           // bumped each time a new PDF doc is loaded
  const [serverDocId, setServerDocId] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [pendingDownload, setPendingDownload] = useState<{ url: string, filename: string } | null>(null)

  // Keep pdfBytesRef in sync
  useEffect(() => {
    pdfBytesRef.current = pdfBytes
  }, [pdfBytes])

  // ---- Warm up the server on app load (prevents Render cold-start delay) ----
  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    fetch(`${API_URL}/health`).catch(() => {/* silently ignore */ })
  }, [])

  // ---- Toast helper ----
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(''), 2500)
  }, [])

  // ---- History helpers ----
  const pushHistory = useCallback((newAnnotations: Annotation[]) => {
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndex + 1)
      return [...trimmed, [...newAnnotations]]
    })
    setHistoryIndex(prev => prev + 1)
  }, [historyIndex])

  const undo = useCallback(() => {
    if (historyIndex <= 0) return
    const newIdx = historyIndex - 1
    setHistoryIndex(newIdx)
    setAnnotations([...history[newIdx]])
  }, [history, historyIndex])

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    const newIdx = historyIndex + 1
    setHistoryIndex(newIdx)
    setAnnotations([...history[newIdx]])
  }, [history, historyIndex])



  // ---- Render a page (with cancellation) ----
  const renderPage = useCallback(async (pageNum: number, zoomScale: number) => {
    if (!pdfDocRef.current) return

    // Cancel any in-flight render
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel() } catch (_) { /* ignore */ }
      renderTaskRef.current = null
    }

    try {
      const page = await pdfDocRef.current.getPage(pageNum)
      const vp = page.getViewport({ scale: zoomScale })
      setCanvasWidth(vp.width)
      setCanvasHeight(vp.height)
      setPdfPage(page)
      setPdfViewport(vp)   // expose viewport for TextEditLayer

      const canvas = canvasRef.current
      if (!canvas) return

      // Force hardware oversampling (min 2x) for ultra-crisp text rendering like Sejda
      const pixelRatio = Math.max(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(vp.width * pixelRatio)
      canvas.height = Math.floor(vp.height * pixelRatio)
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // INTERCEPT: Completely suppress canvas text rendering!
      // This allows us to replace all blurry PDF text with crisp vector HTML text.
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
      console.error('Render error:', err)
    }
  }, [])

  // Re-render on page / scale change
  useEffect(() => {
    if (pdfDocRef.current && pdfReady > 0) {
      renderPage(currentPage, scale)
    }
  }, [currentPage, scale, pdfReady, renderPage])

  // ---- Mobile Responsive Fit ----
  useEffect(() => {
    let timeoutId: any
    const handleResize = () => {
      if (window.innerWidth <= 768 && pdfDocRef.current) {
        clearTimeout(timeoutId)
        timeoutId = setTimeout(async () => {
          try {
            const page = await pdfDocRef.current!.getPage(1)
            const baseVp = page.getViewport({ scale: 1.0 })
            const targetWidth = window.innerWidth - 32 // match padding
            setScale(targetWidth / baseVp.width)
          } catch (e) {
            console.error(e)
          }
        }, 150) // Debounce slightly
      }
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(timeoutId)
    }
  }, [])

  // ---- Load PDF from bytes ----
  const loadPdfFromBytes = useCallback(async (bytes: Uint8Array, name: string) => {
    setLoading(true)
    try {
      // Cancel any in-flight render first
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch (_) { /* ignore */ }
        renderTaskRef.current = null
      }

      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) }) // copy to avoid detached buffer
      const pdf = await loadingTask.promise

      // Calculate responsive scale to perfectly fit mobile, or 1.6 for desktop
      const firstPage = await pdf.getPage(1)
      const baseVp = firstPage.getViewport({ scale: 1.0 })
      let initialScale = 1.6
      if (window.innerWidth <= 768) {
        // Screen width minus side padding (approx 32px)
        const targetWidth = window.innerWidth - 32
        initialScale = targetWidth / baseVp.width
      }

      pdfDocRef.current = pdf
      setPdfBytes(bytes)
      pdfBytesRef.current = bytes
      setFileName(name)
      setNumPages(pdf.numPages)
      setCurrentPage(1)
      setAnnotations([])
      setTextEdits([])
      setHistory([[]])
      setHistoryIndex(0)
      setSelectedId(null)
      setScale(initialScale)

      // Bump pdfReady to trigger the useEffect render
      setPdfReady(prev => prev + 1)

      showToast(`Loaded "${name}" — ${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}`)
    } catch (err) {
      console.error(err)
      showToast('Failed to load PDF. Please try another file.')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  // ---- File input handler ----
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfFileObj(file)
    const buf = await file.arrayBuffer()
    await loadPdfFromBytes(new Uint8Array(buf), file.name)
    // Reset input so same file can be re-loaded
    e.target.value = ''
  }, [loadPdfFromBytes])

  // ---- Drag & Drop ----
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || file.type !== 'application/pdf') {
      showToast('Please drop a PDF file.')
      return
    }
    setPdfFileObj(file)
    const buf = await file.arrayBuffer()
    await loadPdfFromBytes(new Uint8Array(buf), file.name)
  }, [loadPdfFromBytes, showToast])

  // ---- Export ----
  const handleExport = useCallback(async () => {
    const bytes = pdfBytesRef.current
    if (!bytes) {
      showToast('No PDF file loaded.')
      return
    }
    setIsExporting(true)
    showToast('Applying high-fidelity edits on server... Please wait.')
    try {
      const formData = new FormData()
      // Use the current in-memory bytes (which includes any inserted/deleted pages)
      // instead of the original uploaded file
      const currentBlob = new Blob([bytes], { type: 'application/pdf' })
      formData.append('file', currentBlob, fileName || 'document.pdf')
      formData.append('annotations', JSON.stringify(annotations))
      formData.append('textEdits', JSON.stringify(textEdits))
      formData.append('scale', scale.toString())

      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res = await fetch(`${API_URL}/export`, {
        method: 'POST',
        body: formData
      })
      if (!res.ok) throw new Error(`Server export failed: ${res.statusText}`)

      const contentType = res.headers.get('content-type')
      if (contentType && contentType.includes('text/html')) {
        const text = await res.text()
        console.error("Received HTML instead of PDF:", text)
        throw new Error("Server returned HTML. Ensure backend URL is correct.")
      }

      const exportedBlob = new Blob([await res.blob()], { type: 'application/pdf' })
      const url = URL.createObjectURL(exportedBlob)
      const filename = fileName ? fileName.replace(/\.pdf$/i, '_edited.pdf') : 'edited.pdf'

      // Delay revoking so download has time to start (handled in interstitial now)
      setTimeout(() => URL.revokeObjectURL(url), 60000)

      // Show interstitial which handles the download
      setPendingDownload({ url, filename })
      showToast('PDF exported securely with pixel-perfect accuracy!')
    } catch (err) {
      console.error(err)
      showToast('Export failed. Make sure server is running.')
    } finally {
      setIsExporting(false)
    }
  }, [annotations, textEdits, scale, fileName, showToast])

  // ---- Annotation CRUD ----
  const addAnnotation = useCallback((ann: Annotation) => {
    setAnnotations(prev => {
      const updated = [...prev, ann]
      // Push to history
      setHistory(h => {
        const trimmed = h.slice(0, historyIndex + 1)
        return [...trimmed, [...updated]]
      })
      setHistoryIndex(i => i + 1)
      return updated
    })
  }, [historyIndex])

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>) => {
    setAnnotations(prev => {
      const updated = prev.map(a => a.id === id ? { ...a, ...patch } : a)
      // Save to history only for property changes (fontSize, fontColor, fontStyle, fontWeight, color, opacity)
      const isPropertyChange = Object.keys(patch).some(k =>
        ['fontSize', 'fontColor', 'fontStyle', 'fontWeight', 'color', 'opacity'].includes(k)
      )
      if (isPropertyChange) {
        setHistory(h => {
          const trimmed = h.slice(0, historyIndex + 1)
          return [...trimmed, [...updated]]
        })
        setHistoryIndex(i => i + 1)
      }
      return updated
    })
  }, [historyIndex])

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations(prev => {
      const updated = prev.filter(a => a.id !== id)
      setHistory(h => {
        const trimmed = h.slice(0, historyIndex + 1)
        return [...trimmed, [...updated]]
      })
      setHistoryIndex(i => i + 1)
      return updated
    })
    setSelectedId(prev => prev === id ? null : prev)
    showToast('Annotation deleted')
  }, [historyIndex, showToast])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteAnnotation(selectedId)
  }, [selectedId, deleteAnnotation])

  // ---- Keyboard shortcuts   // Undo / Redo keyboard shortcuts ONLY (removed tool/zoom shortcuts for clean UI)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input or contenteditable
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if ((e.target as HTMLElement).isContentEditable) return

      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.ctrlKey && e.key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo])

  // Finalize on mouseup — ONLY if a drag/resize actually happened
  useEffect(() => {
    const handleMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      // Push current annotations to history
      setAnnotations(current => {
        setHistory(h => {
          const trimmed = h.slice(0, historyIndex + 1)
          return [...trimmed, [...current]]
        })
        setHistoryIndex(i => i + 1)
        return current
      })
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [historyIndex])

  // ---- Page navigation ----
  const prevPage = () => setCurrentPage(p => Math.max(1, p - 1))
  const nextPage = () => setCurrentPage(p => Math.min(numPages, p + 1))

  const [showPropsPanel, setShowPropsPanel] = useState(true)

  // ---- Page operations (via pdf-lib) ----
  const reloadPdfFromBytes = useCallback(async (newBytes: Uint8Array) => {
    const loadingTask = pdfjsLib.getDocument({ data: newBytes.slice(0) })
    const pdf = await loadingTask.promise
    pdfDocRef.current = pdf
    setPdfBytes(newBytes)
    pdfBytesRef.current = newBytes
    setNumPages(pdf.numPages)
    setAnnotations([])
    setTextEdits([])
    setHistory([[]])
    setHistoryIndex(0)
    setSelectedId(null)
  }, [])

  const deletePage = useCallback(async (pageNum: number) => {
    if (!pdfBytes || numPages <= 1) {
      showToast('Cannot delete the only page')
      return
    }
    try {
      const doc = await PDFDocument.load(pdfBytes)
      doc.removePage(pageNum - 1) // 0-indexed
      const saved = await doc.save()
      const newBytes = new Uint8Array(saved)
      if (currentPage > numPages - 1) setCurrentPage(numPages - 1)
      await reloadPdfFromBytes(newBytes)
      showToast(`Deleted page ${pageNum}`)
    } catch (err) {
      console.error(err)
      showToast('Failed to delete page')
    }
  }, [pdfBytes, numPages, currentPage, reloadPdfFromBytes, showToast])

  const insertBlankPage = useCallback(async (beforePageNum: number) => {
    if (!pdfBytes) return
    try {
      const doc = await PDFDocument.load(pdfBytes)
      // Get size of the page we're inserting before, to match dimensions
      const refPage = doc.getPage(Math.min(beforePageNum - 1, doc.getPageCount() - 1))
      const { width, height } = refPage.getSize()
      doc.insertPage(beforePageNum - 1, [width, height])
      const saved = await doc.save()
      await reloadPdfFromBytes(new Uint8Array(saved))
      showToast(`Inserted blank page before page ${beforePageNum}`)
    } catch (err) {
      console.error(err)
      showToast('Failed to insert page')
    }
  }, [pdfBytes, reloadPdfFromBytes, showToast])

  // ---- Tool button helper ----
  const ToolBtn = ({ value, icon, label }: { value: ToolType; icon: React.ReactNode; label: string }) => (
    <button
      className={`icon-btn ${tool === value ? 'active' : ''}`}
      onClick={() => setTool(value)}
      title={label}
    >
      {icon}
      <span className="btn-tooltip">{label}</span>
    </button>
  )

  // ---- Selected annotation properties ----
  const selectedAnn = annotations.find(a => a.id === selectedId) || null

  // ---- Render ----
  return (
    <div
      className="app-root"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* PDF Loading Overlay — shown while server extracts text */}
      {(loading || extractLoading) && pdfBytes && (
        <div className="pdf-loading-overlay">
          <div className="pdf-loading-card">
            <div className="pdf-loading-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </div>
            <div className="pdf-loading-title">Processing PDF</div>
            <div className="pdf-loading-filename">{fileName || 'document.pdf'}</div>
            <div className="pdf-loading-bar-wrap">
              <div className="pdf-loading-bar" />
            </div>
            <div className="pdf-loading-steps">
              <PdfLoadingStep delay={0} text="Uploading document" />
              <PdfLoadingStep delay={1200} text="Extracting text & fonts" />
              <PdfLoadingStep delay={2800} text="Mapping coordinates" />
              <PdfLoadingStep delay={4200} text="Preparing editor" />
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div className={`toast ${toastMsg ? 'show' : ''}`}>{toastMsg}</div>

      {/* Post-export interstitial ad */}
      {pendingDownload && (
        <ExportInterstitial pendingDownload={pendingDownload} onClose={() => setPendingDownload(null)} />
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {/* ============ HEADER — only when editing ============ */}
      {pdfBytes && (
        <header className="app-header">
          <div className="app-logo">
            <IconPDF />
            <span>PDF Studio</span>
          </div>

          {(docColors.length > 0 || docFonts.length > 0) && (
            <div className="doc-palette-header" style={{ display: 'flex', alignItems: 'center', gap: '20px', flex: 1, paddingLeft: '32px' }}>

              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Colors
                  </span>
                  <button
                    onClick={() => setShowColorPicker(!showColorPicker)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)',
                      background: 'var(--bg-primary)', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)'
                    }}
                  >
                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: activeColor || '#000', border: '1px solid var(--border-default)' }} />
                    {activeColor || 'Select'}
                  </button>
                </div>

                {showColorPicker && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, marginTop: '8px', zIndex: 100,
                    background: 'var(--bg-primary)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                    padding: '16px', boxShadow: 'var(--shadow-lg)', width: '280px',
                    display: 'flex', flexDirection: 'column', gap: '16px'
                  }}>
                    {docColors.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                          Document Colors
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: '6px' }}>
                          {docColors.map(c => (
                            <div
                              key={c}
                              onClick={() => { setActiveColor(c); setShowColorPicker(false); }}
                              style={{
                                width: 20, height: 20, borderRadius: 4, background: c,
                                border: activeColor === c ? '2px solid var(--accent)' : '1px solid var(--border-default)',
                                cursor: 'pointer', boxShadow: activeColor === c ? '0 0 0 2px rgba(26,115,232,0.2)' : 'none'
                              }}
                              title={c}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                        All Other Colors
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: '6px' }}>
                        {STANDARD_COLORS.map(c => (
                          <div
                            key={c}
                            onClick={() => { setActiveColor(c); setShowColorPicker(false); }}
                            style={{
                              width: 20, height: 20, borderRadius: 4, background: c,
                              border: activeColor === c ? '2px solid var(--accent)' : '1px solid var(--border-default)',
                              cursor: 'pointer', boxShadow: activeColor === c ? '0 0 0 2px rgba(26,115,232,0.2)' : 'none'
                            }}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {docColors.length > 0 && docFonts.length > 0 && <div className="toolbar-sep" style={{ height: '20px', margin: '0' }} />}

              {docFonts.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Document Fonts
                  </span>
                  <select
                    className="input-sm"
                    value={activeFont || ''}
                    onChange={e => setActiveFont(e.target.value)}
                    style={{ width: 140, padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)' }}
                  >
                    {docFonts.map(f => (
                      <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="header-actions">
            <button className="btn-ghost" onClick={() => setShowPropsPanel(p => !p)} title={showPropsPanel ? 'Hide Panel' : 'Show Panel'}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              <span className="hide-mobile">{showPropsPanel ? 'Hide' : 'Panel'}</span>
            </button>
            <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
              <IconUpload />
              <span className="hide-mobile">New PDF</span>
            </button>
            <button className={`btn-primary ${isExporting ? 'exporting' : ''}`} onClick={handleExport} disabled={!pdfBytes || isExporting}>
              {isExporting ? <div className="spinner" /> : <IconDownload />}
              <span className="hide-mobile">{isExporting ? 'Exporting...' : 'Export'}</span>
            </button>
          </div>
        </header>
      )}

      {/* Exporting Overlay */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-card">
            <div className="spinner-large" />
            <h3>Processing PDF</h3>
            <p>Applying changes pin-to-pin accurately...</p>
          </div>
        </div>
      )}

      {/* ============ BODY ============ */}
      {!pdfBytes ? (
        /* ---- Full-Screen Landing Page ---- */
        <div className="landing-page">
          {/* Decorative background blobs */}
          <div className="landing-bg">
            <div className="blob blob-1" />
            <div className="blob blob-2" />
            <div className="blob blob-3" />
            <div className="grid-pattern" />
          </div>

          {/* Landing Navbar */}
          <nav className="landing-nav">
            <div className="app-logo">
              <IconPDF />
              <span>PDF Studio</span>
            </div>
            <button className="btn-primary" onClick={() => fileInputRef.current?.click()}>
              <IconUpload /> Get Started
            </button>
          </nav>

          {/* Hero Content */}
          <div className="hero-section">
            <div className="hero-badge">Free · No Signup · No Watermarks</div>
            <h1 className="hero-title">Edit PDFs Online<br /><span className="hero-gradient">In Seconds</span></h1>
            <p className="hero-subtitle">Add text, shapes, highlights, annotations, and freehand drawings. Export pixel-perfect PDFs directly from your browser — no downloads, no accounts.</p>

            <img src="/hero-illustration.svg" alt="Edit documents online" className="hero-illustration" />

            <div className="hero-upload-row">
              <div className={`drop-card ${dragOver ? 'drag-over' : ''}`} onClick={() => fileInputRef.current?.click()}>
                <img src="/OIP.webp" alt="PDF" className="drop-card-illustration" />
                <div className="drop-title">Drop your PDF here</div>
                <div className="drop-subtitle">or click to browse files · Max 50MB</div>
              </div>
            </div>

            <div className="feature-grid">
              <div className="feature-card"><div className="feature-icon fi-indigo"><IconEdit /></div><h3>Edit Text</h3><p>Click any text to edit in-place with original fonts preserved</p></div>
              <div className="feature-card"><div className="feature-icon fi-sky"><IconSquare /></div><h3>Add Shapes</h3><p>Rectangles, circles, and lines with custom colors</p></div>
              <div className="feature-card"><div className="feature-icon fi-amber"><IconHighlighter /></div><h3>Highlight</h3><p>Mark important passages with adjustable colors</p></div>
              <div className="feature-card"><div className="feature-icon fi-emerald"><IconPen /></div><h3>Freehand Draw</h3><p>Sketch annotations, signatures, or notes</p></div>
              <div className="feature-card"><div className="feature-icon fi-violet"><IconType /></div><h3>Add Text</h3><p>Place text boxes anywhere on the page</p></div>
              <div className="feature-card"><div className="feature-icon fi-rose"><IconDownload /></div><h3>Export PDF</h3><p>Download with all changes permanently saved</p></div>
            </div>

            {/* Ad: In-feed native between features and trust */}
            <AdSlot slot="4531873612" format="fluid" className="ad-landing-infeed" layoutKey="-fb+5w+4e-db+86" />

            <div className="trust-section">
              <div className="trust-item"><strong>100%</strong><span>Browser-based</span></div>
              <div className="trust-divider" />
              <div className="trust-item"><strong>0</strong><span>Watermarks</span></div>
              <div className="trust-divider" />
              <div className="trust-item"><strong>Free</strong><span>Forever</span></div>
              <div className="trust-divider" />
              <div className="trust-item"><strong>Secure</strong><span>Files stay private</span></div>
            </div>

            {/* Ad: Banner above footer */}
            <AdSlot slot="8279546939" format="auto" className="ad-landing-banner" />

            <footer className="landing-footer">
              <p>Built with care · Your files never leave your browser</p>
            </footer>
          </div>
        </div>
      ) : (
        <div className="app-body">

          {/* ---- Left Sidebar ---- */}
          <aside className="tools-sidebar">
            <ToolBtn value="select" icon={<IconCursor />} label="Select (V)" />
            <ToolBtn value="edit" icon={<IconEdit />} label="Edit Text (E)" />
            <ToolBtn value="text" icon={<IconType />} label="Add Text (T)" />
            <ToolBtn value="highlight" icon={<IconHighlighter />} label="Highlight (H)" />
            <ToolBtn value="ink" icon={<IconPen />} label="Freehand (P)" />
            <ToolBtn value="rect" icon={<IconSquare />} label="Rectangle" />
            <ToolBtn value="ellipse" icon={<IconCircle />} label="Circle" />
            <ToolBtn value="line" icon={<IconLine />} label="Line" />
            <ToolBtn value="pan" icon={<IconHand />} label="Pan (G)" />

            <div style={{ width: '36px', height: '1px', background: 'var(--border-default)', margin: '8px 0' }} />

            <button className="tool-btn" onClick={undo} disabled={historyIndex <= 0} title="Undo">
              <IconUndo />
            </button>
            <button className="tool-btn" onClick={redo} disabled={historyIndex >= history.length - 1} title="Redo">
              <IconRedo />
            </button>

            <div style={{ width: '36px', height: '1px', background: 'var(--border-default)', margin: '8px 0' }} />

            <button className="tool-btn" onClick={deleteSelected} disabled={!selectedId} title="Delete">
              <IconTrash />
            </button>
          </aside>

          {/* ---- Main Canvas Area ---- */}
          <div className="canvas-area">
            {!pdfBytes ? null : (
              <>
                {/* Vertical Scroll PDF Container */}
                <div className="canvas-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto' }}>
                  {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
                    <PdfPageRenderer
                      key={pageNum}
                      pdfDoc={pdfDocRef.current}
                      pageNumber={pageNum}
                      totalPages={numPages}
                      scale={scale}
                      tool={tool}
                      activeColor={activeColor}
                      activeFont={activeFont}
                      setActiveColor={setActiveColor}
                      setActiveFont={setActiveFont}
                      docFonts={docFonts}
                      docColors={docColors}
                      extractedItems={extractedItems}
                      annotations={annotations.filter(a => a.page === pageNum)}
                      textEdits={textEdits}
                      selectedId={selectedId}
                      onAddAnnotation={addAnnotation}
                      onUpdateAnnotation={updateAnnotation}
                      onDeleteAnnotation={deleteAnnotation}
                      onSelectAnnotation={setSelectedId}
                      onDeletePage={deletePage}
                      onInsertBlankPage={insertBlankPage}
                      onTextEdit={(edit) => {
                        setTextEdits(prev => {
                          const idx = prev.findIndex(e => e.id === edit.id)
                          if (idx >= 0) {
                            const updated = [...prev]
                            updated[idx] = edit
                            return updated
                          }
                          return [...prev, edit]
                        })
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ---- Right Properties Panel ---- */}
          {pdfBytes && showPropsPanel && (
            <aside className="props-panel">
              <div>
                <div className="props-section-title">Document</div>
                <div className="props-row">
                  <label>File</label>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fileName || 'Untitled'}
                  </span>
                </div>
                <div className="props-row">
                  <label>Pages</label>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{numPages}</span>
                </div>

              </div>

              <div>
                <div className="props-section-title">Annotations ({annotations.filter(a => a.page === currentPage).length})</div>
                {annotations.filter(a => a.page === currentPage).length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    No annotations on this page yet.<br />
                    Select a tool and click on the canvas.
                  </div>
                )}
                {annotations.filter(a => a.page === currentPage).map(ann => (
                  <div
                    key={ann.id}
                    onClick={() => setSelectedId(ann.id)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: selectedId === ann.id ? 'var(--bg-hover)' : 'transparent',
                      border: selectedId === ann.id ? '1px solid var(--border-hover)' : '1px solid transparent',
                      cursor: 'pointer',
                      marginBottom: 4,
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      transition: 'all 0.15s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ textTransform: 'capitalize', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {ann.type}
                    </span>
                    {ann.type === 'text' && (
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {ann.text || '(empty)'}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Selected annotation properties */}
              {selectedAnn && (
                <div>
                  <div className="props-section-title">Properties</div>
                  <div className="props-row">
                    <label>Type</label>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                      {selectedAnn.type}
                    </span>
                  </div>

                  {selectedAnn.type === 'text' && (
                    <>
                      <div className="props-row">
                        <label>Font Size</label>
                        <input
                          type="number"
                          className="input-sm input-sm-narrow"
                          value={selectedAnn.fontSize || 14}
                          min={8}
                          max={72}
                          onChange={(e) => {
                            const val = parseInt(e.target.value)
                            if (!isNaN(val)) {
                              updateAnnotation(selectedAnn.id, { fontSize: val })
                            }
                          }}
                        />
                      </div>
                      <div className="props-row">
                        <label>Color</label>
                        <input
                          type="color"
                          className="color-swatch"
                          value={selectedAnn.fontColor || '#000000'}
                          onChange={(e) => {
                            updateAnnotation(selectedAnn.id, { fontColor: e.target.value })
                          }}
                        />
                      </div>
                    </>
                  )}

                  {selectedAnn.type === 'highlight' && (
                    <>
                      <div className="props-row">
                        <label>Color</label>
                        <input
                          type="color"
                          className="color-swatch"
                          value={selectedAnn.color || '#fbbf24'}
                          onChange={(e) => {
                            updateAnnotation(selectedAnn.id, { color: e.target.value })
                          }}
                        />
                      </div>
                      <div className="props-row">
                        <label>Opacity</label>
                        <input
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.05}
                          value={selectedAnn.opacity ?? 0.3}
                          onChange={(e) => {
                            updateAnnotation(selectedAnn.id, { opacity: parseFloat(e.target.value) })
                          }}
                          style={{ flex: 1 }}
                        />
                      </div>
                    </>
                  )}

                  {selectedAnn.type === 'ink' && (
                    <div className="props-row">
                      <label>Color</label>
                      <input
                        type="color"
                        className="color-swatch"
                        value={selectedAnn.fontColor || '#818cf8'}
                        onChange={(e) => {
                          updateAnnotation(selectedAnn.id, { fontColor: e.target.value })
                        }}
                      />
                    </div>
                  )}

                  {(selectedAnn.type === 'rect' || selectedAnn.type === 'ellipse' || selectedAnn.type === 'line') && (
                    <>
                      <div className="props-row">
                        <label>Stroke</label>
                        <input
                          type="color"
                          className="color-swatch"
                          value={selectedAnn.strokeColor || '#000000'}
                          onChange={(e) => {
                            updateAnnotation(selectedAnn.id, { strokeColor: e.target.value })
                          }}
                        />
                      </div>
                      {selectedAnn.type !== 'line' && (
                        <div className="props-row">
                          <label>Fill</label>
                          <input
                            type="color"
                            className="color-swatch"
                            value={selectedAnn.fillColor || '#transparent'}
                            onChange={(e) => {
                              updateAnnotation(selectedAnn.id, { fillColor: e.target.value })
                            }}
                          />
                        </div>
                      )}
                      <div className="props-row">
                        <label>Thickness</label>
                        <input
                          type="number"
                          className="input-sm input-sm-narrow"
                          value={selectedAnn.strokeWidth || 2}
                          min={1}
                          max={20}
                          onChange={(e) => {
                            const val = parseInt(e.target.value)
                            if (!isNaN(val)) {
                              updateAnnotation(selectedAnn.id, { strokeWidth: val })
                            }
                          }}
                        />
                      </div>
                    </>
                  )}

                  <div style={{ marginTop: 8 }}>
                    <button className="btn-ghost" onClick={() => deleteAnnotation(selectedAnn.id)} style={{ color: 'var(--danger)', borderColor: 'rgba(248, 113, 113, 0.3)', width: '100%', justifyContent: 'center' }}>
                      <IconTrash />
                      Delete Annotation
                    </button>
                  </div>
                </div>
              )}

              {/* Keyboard shortcuts */}
              <div style={{ marginTop: 'auto' }}>
                <div className="props-section-title">Shortcuts</div>
                {[
                  ['V', 'Select'],
                  ['E', 'Edit Text'],
                  ['T', 'Add Text'],
                  ['H', 'Highlight'],
                  ['P', 'Freehand'],
                  ['G', 'Pan'],
                  ['Del', 'Delete'],
                  ['Ctrl+Z', 'Undo'],
                  ['Ctrl+Y', 'Redo'],
                  ['+/-', 'Zoom'],
                ].map(([key, desc]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                    <span>{desc}</span>
                    <kbd style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)' }}>{key}</kbd>
                  </div>
                ))}
              </div>
            </aside>
          )}
        </div>
      )}
    </div >
  )
}
