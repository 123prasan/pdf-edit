const express = require('express')
const multer = require('multer')
const cors = require('cors')
const { PDFDocument } = require('pdf-lib')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())

// Store documents in memory for this prototype (in production, use AWS S3/Redis)
const documents = new Map()

const upload = multer({ storage: multer.memoryStorage() })

// 1. Upload the PDF document to the server
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    const pdfDoc = await PDFDocument.load(req.file.buffer, { ignoreEncryption: true })
    const numPages = pdfDoc.getPageCount()
    const docId = Date.now().toString()

    // Store the raw buffer
    documents.set(docId, {
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      numPages
    })

    console.log(`Uploaded document: ${docId} with ${numPages} pages`)

    res.json({ docId, numPages, fileName: req.file.originalname })
  } catch (error) {
    console.error('Upload error:', error)
    res.status(500).json({ error: 'Failed to process PDF file.' })
  }
})

// 2. Serve a specific page as its own miniature PDF
app.get('/api/document/:id/page/:pageNum', async (req, res) => {
  try {
    const { id, pageNum } = req.params
    const doc = documents.get(id)
    
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' })
    }

    const pageIndex = parseInt(pageNum, 10) - 1 // 0-indexed internally
    if (pageIndex < 0 || pageIndex >= doc.numPages) {
      return res.status(400).json({ error: 'Invalid page number' })
    }

    console.log(`Serving page ${pageNum} for document ${id}...`)

    // Load original doc
    const originalPdf = await PDFDocument.load(doc.buffer, { ignoreEncryption: true })
    
    // Create a new empty document
    const singlePagePdf = await PDFDocument.create()
    
    // Copy only the requested page
    const [copiedPage] = await singlePagePdf.copyPages(originalPdf, [pageIndex])
    singlePagePdf.addPage(copiedPage)

    // Save and send back the single-page PDF bytes
    const pdfBytes = await singlePagePdf.save()
    
    res.setHeader('Content-Type', 'application/pdf')
    res.send(Buffer.from(pdfBytes))
  } catch (error) {
    console.error('Page generation error:', error)
    res.status(500).json({ error: 'Failed to generate page.' })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Sejda-Style PDF Backend Server running on port ${PORT}`)
})
