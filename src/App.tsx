import React, { useState, useRef, useCallback, useEffect } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf'
import AnnotationLayer from './components/AnnotationLayer'
import TextEditLayer from './components/TextEditLayer'
import type { TextEdit } from './components/TextEditLayer'
import { exportPdfWithAnnotations } from './utils/pdfUtils'
import {
  IconUpload, IconDownload, IconCursor, IconEdit, IconType, IconHighlighter,
  IconPen, IconHand, IconChevronLeft,
  IconChevronRight, IconTrash, IconUndo, IconRedo, IconPDF,
  IconPlus, IconMinus, IconMaximize, IconFile
} from './components/Icons'
import type { Annotation, ToolType } from './types'

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${(pdfjsLib as any).version}/pdf.worker.min.js`

/* ============================================================
   PDF Studio — Enterprise PDF Editor
   ============================================================ */

export default function App() {
  // ---- State ----
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [canvasWidth, setCanvasWidth] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const [tool, setTool] = useState<ToolType>('select')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toastMsg, setToastMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [textEdits, setTextEdits] = useState<TextEdit[]>([])
  const [pdfPage, setPdfPage] = useState<any>(null)        // current pdf.js page object
  const [pdfViewport, setPdfViewport] = useState<any>(null) // current viewport (at scale)

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

  // Keep pdfBytesRef in sync
  useEffect(() => {
    pdfBytesRef.current = pdfBytes
  }, [pdfBytes])

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
      setScale(1.0)

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
    const buf = await file.arrayBuffer()
    await loadPdfFromBytes(new Uint8Array(buf), file.name)
  }, [loadPdfFromBytes, showToast])

  // ---- Export ----
  const handleExport = useCallback(async () => {
    const bytes = pdfBytesRef.current
    if (!bytes) return
    setLoading(true)
    try {
      const exported = await exportPdfWithAnnotations(bytes, annotations, textEdits, scale)
      const blob = new Blob([exported], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName ? fileName.replace(/\.pdf$/i, '_edited.pdf') : 'edited.pdf'
      a.click()
      URL.revokeObjectURL(url)
      showToast('PDF exported successfully!')
    } catch (err) {
      console.error(err)
      showToast('Export failed. Please try again.')
    } finally {
      setLoading(false)
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
    isDraggingRef.current = true
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a))
  }, [])

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

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected()
      }
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault()
        undo()
      }
      if (e.ctrlKey && e.key === 'y') {
        e.preventDefault()
        redo()
      }
      if (e.key === 'v') setTool('select')
      if (e.key === 'e') setTool('edit')
      if (e.key === 't') setTool('text')
      if (e.key === 'h') setTool('highlight')
      if (e.key === 'p') setTool('ink')
      if (e.key === 'g') setTool('pan')
      if (e.key === '+' || e.key === '=') setScale(s => Math.min(3, s + 0.1))
      if (e.key === '-') setScale(s => Math.max(0.25, s - 0.1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deleteSelected, undo, redo])

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

  // ---- Zoom helpers ----
  const zoomIn = () => setScale(s => Math.min(3, Math.round((s + 0.25) * 100) / 100))
  const zoomOut = () => setScale(s => Math.max(0.25, Math.round((s - 0.25) * 100) / 100))
  const zoomFit = () => setScale(1.0)
  const zoomPercent = Math.round(scale * 100)

  // ---- Page navigation ----
  const prevPage = () => setCurrentPage(p => Math.max(1, p - 1))
  const nextPage = () => setCurrentPage(p => Math.min(numPages, p + 1))

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
      {/* Loading overlay */}
      {loading && (
        <div className="loading-overlay">
          <div className="spinner" />
        </div>
      )}

      {/* Toast */}
      <div className={`toast ${toastMsg ? 'show' : ''}`}>{toastMsg}</div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {/* ============ HEADER ============ */}
      <header className="app-header">
        <div className="app-logo">
          <IconPDF />
          <span>PDF Studio</span>
        </div>

        <div className="header-actions">
          <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}>
            <IconUpload />
            Open PDF
          </button>
          <button className="btn-primary" onClick={handleExport} disabled={!pdfBytes}>
            <IconDownload />
            Export
          </button>
        </div>
      </header>

      {/* ============ BODY ============ */}
      <div className="app-body">

        {/* ---- Left Sidebar ---- */}
        <aside className="sidebar">
          <ToolBtn value="select" icon={<IconCursor />} label="Select (V)" />
          <ToolBtn value="edit" icon={<IconEdit />} label="Edit Text (E)" />
          <ToolBtn value="text" icon={<IconType />} label="Add Text (T)" />
          <ToolBtn value="highlight" icon={<IconHighlighter />} label="Highlight (H)" />
          <ToolBtn value="ink" icon={<IconPen />} label="Freehand (P)" />
          <ToolBtn value="pan" icon={<IconHand />} label="Pan (G)" />

          <div className="sidebar-divider" />

          <button className="icon-btn" onClick={undo} disabled={historyIndex <= 0} title="Undo">
            <IconUndo />
            <span className="btn-tooltip">Undo (Ctrl+Z)</span>
          </button>
          <button className="icon-btn" onClick={redo} disabled={historyIndex >= history.length - 1} title="Redo">
            <IconRedo />
            <span className="btn-tooltip">Redo (Ctrl+Y)</span>
          </button>

          <div className="sidebar-divider" />

          <button className="icon-btn" onClick={deleteSelected} disabled={!selectedId} title="Delete">
            <IconTrash />
            <span className="btn-tooltip">Delete (Del)</span>
          </button>

          <div className="sidebar-spacer" />

          {/* Zoom controls */}
          <button className="icon-btn" onClick={zoomOut} title="Zoom Out">
            <IconMinus />
          </button>
          <span className="zoom-label">{zoomPercent}%</span>
          <button className="icon-btn" onClick={zoomIn} title="Zoom In">
            <IconPlus />
          </button>
          <button className="icon-btn" onClick={zoomFit} title="Fit to Width">
            <IconMaximize />
          </button>
        </aside>

        {/* ---- Main Canvas Area ---- */}
        <div className="canvas-area">
          {!pdfBytes ? (
            /* Welcome / Drop Zone */
            <div className="welcome-zone">
              <div
                className={`drop-card ${dragOver ? 'drag-over' : ''}`}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="drop-icon">
                  <IconFile />
                </div>
                <div className="drop-title">Open a PDF to get started</div>
                <div className="drop-subtitle">
                  Drag & drop a PDF file here, or click to browse.<br />
                  Add text, highlights, freehand drawings, then export.
                </div>
                <div className="drop-badge">
                  <IconUpload /> Supports any PDF file
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Canvas + Annotation overlay */}
              <div className="canvas-scroll">
                {/* canvasWidth/Height already = naturalSize × scale from vp.width/vp.height */}
                <div className="canvas-wrapper" style={{ width: canvasWidth, height: canvasHeight }}>
                  <canvas
                    ref={canvasRef}
                    style={{ display: 'block', width: canvasWidth, height: canvasHeight }}
                  />
                  <AnnotationLayer
                    canvasWidth={canvasWidth}
                    canvasHeight={canvasHeight}
                    annotations={annotations.filter(a => a.page === currentPage)}
                    tool={tool}
                    page={currentPage}
                    scale={scale}
                    onAddAnnotation={addAnnotation}
                    onUpdateAnnotation={updateAnnotation}
                    onDeleteAnnotation={deleteAnnotation}
                    onSelectAnnotation={setSelectedId}
                    selectedId={selectedId}
                  />
                  {pdfPage && pdfViewport && (
                    <TextEditLayer
                      pdfPage={pdfPage}
                      viewport={pdfViewport}
                      scale={scale}
                      page={currentPage}
                      canvasWidth={canvasWidth}
                      canvasHeight={canvasHeight}
                      canvasRef={canvasRef}
                      textEdits={textEdits}
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
                      active={tool === 'edit'}
                    />
                  )}
                </div>
              </div>

              {/* Page Navigation */}
              <div className="page-nav">
                <button className="icon-btn" onClick={prevPage} disabled={currentPage <= 1}>
                  <IconChevronLeft />
                </button>
                <span className="page-info">
                  Page <strong>{currentPage}</strong> of <strong>{numPages}</strong>
                </span>
                <button className="icon-btn" onClick={nextPage} disabled={currentPage >= numPages}>
                  <IconChevronRight />
                </button>
              </div>
            </>
          )}
        </div>

        {/* ---- Right Properties Panel ---- */}
        {pdfBytes && (
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
              <div className="props-row">
                <label>Zoom</label>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{zoomPercent}%</span>
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
                        value={selectedAnn.fontColor || '#ffffff'}
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

      {/* ============ STATUS BAR ============ */}
      <div className="status-bar">
        <div className="status-dot" />
        <span>Ready</span>
        {pdfBytes && (
          <>
            <span>|</span>
            <span>{annotations.length} annotation{annotations.length !== 1 ? 's' : ''}</span>
            <span>|</span>
            <span>Page {currentPage}/{numPages}</span>
            <span>|</span>
            <span>{zoomPercent}% zoom</span>
          </>
        )}
      </div>
    </div>
  )
}
