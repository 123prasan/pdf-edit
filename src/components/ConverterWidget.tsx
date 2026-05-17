import React, { useState } from 'react';

type ConverterTool = {
  id: string;
  name: string;
  endpoint: string;
  accept: string;
  buttonText: string;
};

const TOOLS: ConverterTool[] = [
  { id: 'word-to-pdf', name: 'Word to PDF', endpoint: '/convert/word-to-pdf', accept: '.doc,.docx', buttonText: 'Convert to PDF' },
  { id: 'pdf-to-doc', name: 'PDF to Word', endpoint: '/convert/pdf-to-doc', accept: '.pdf', buttonText: 'Convert to Word' },
  { id: 'image-to-pdf', name: 'Image to PDF', endpoint: '/convert/image-to-pdf', accept: 'image/*', buttonText: 'Convert to PDF' },
  { id: 'compress-pdf', name: 'Compress PDF', endpoint: '/convert/compress-pdf', accept: '.pdf', buttonText: 'Compress' },
  { id: 'ocr-extract', name: 'OCR Extract Text', endpoint: '/convert/ocr-extract', accept: 'image/*', buttonText: 'Extract Text' },
];

export default function ConverterWidget() {
  const [activeTool, setActiveTool] = useState<ConverterTool>(TOOLS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleProcess = async () => {
    if (!file) return;
    setIsLoading(true);
    setError('');

    try {
      const formData = new FormData();
      // Most routes expect the file field to match the tool name, but we standardized it 
      // in main.py to accept specific names. Let's map them:
      const fieldMap: Record<string, string> = {
        'word-to-pdf': 'word',
        'pdf-to-doc': 'pdf',
        'image-to-pdf': 'image',
        'compress-pdf': 'file',
        'ocr-extract': 'image',
      };
      
      formData.append(fieldMap[activeTool.id] || 'file', file);
      
      // If pdf-to-doc, it expects a secretKey
      if (activeTool.id === 'pdf-to-doc') {
        formData.append('secretKey', 'default-key');
      }
      
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const response = await fetch(`${API_URL}${activeTool.endpoint}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Smart filename extension
      let ext = '.pdf';
      if (activeTool.id === 'pdf-to-doc') ext = '.docx';
      if (activeTool.id === 'ocr-extract') ext = '.txt';
      
      a.download = `converted_${file.name.split('.')[0]}${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
    } catch (err: any) {
      setError(err.message || 'An error occurred during conversion.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif', padding: 20, border: '1px solid #ccc', borderRadius: 8 }}>
      <h2 style={{ marginTop: 0 }}>OmniGrid Tools</h2>
      
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        {TOOLS.map(tool => (
          <button 
            key={tool.id}
            onClick={() => { setActiveTool(tool); setFile(null); setError(''); }}
            style={{
              padding: '8px 16px',
              borderRadius: 20,
              border: 'none',
              background: activeTool.id === tool.id ? '#4f46e5' : '#e5e7eb',
              color: activeTool.id === tool.id ? 'white' : 'black',
              cursor: 'pointer'
            }}
          >
            {tool.name}
          </button>
        ))}
      </div>

      <div style={{ border: '2px dashed #cbd5e1', padding: 40, textAlign: 'center', borderRadius: 8, background: '#f8fafc' }}>
        <h3>{activeTool.name}</h3>
        <input 
          type="file" 
          accept={activeTool.accept}
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          style={{ display: 'block', margin: '20px auto' }}
        />
        {file && <p>Selected: <strong>{file.name}</strong></p>}
        
        {error && <p style={{ color: 'red' }}>{error}</p>}
        
        <button 
          onClick={handleProcess}
          disabled={!file || isLoading}
          style={{
            marginTop: 20,
            padding: '12px 24px',
            fontSize: '16px',
            background: file && !isLoading ? '#10b981' : '#9ca3af',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: file && !isLoading ? 'pointer' : 'not-allowed'
          }}
        >
          {isLoading ? 'Processing...' : activeTool.buttonText}
        </button>
      </div>
    </div>
  );
}
