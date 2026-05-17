import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';

type ToolPageProps = {
  id: string;
  title: string;
  description: string;
  endpoint: string;
  accept: string;
  buttonText: string;
  seoTitle: string;
  seoDescription: string;
};

export default function ToolPage({ id, title, description, endpoint, accept, buttonText, seoTitle, seoDescription }: ToolPageProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleProcess = async () => {
    if (!file) return;
    setIsLoading(true);
    setError('');

    try {
      const formData = new FormData();
      const fieldMap: Record<string, string> = {
        'word-to-pdf': 'word',
        'pdf-to-doc': 'pdf',
        'image-to-pdf': 'image',
        'compress-pdf': 'file',
        'ocr-extract': 'image',
        'ppt-to-pdf': 'ppt',
      };
      
      formData.append(fieldMap[id] || 'file', file);
      
      if (id === 'pdf-to-doc') {
        formData.append('secretKey', 'default-key');
      }
      
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
      const response = await fetch(`${API_URL}${endpoint}`, {
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
      
      let ext = '.pdf';
      if (id === 'pdf-to-doc') ext = '.docx';
      if (id === 'ocr-extract') ext = '.txt';
      
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
    <>
      <Helmet>
        <title>{seoTitle}</title>
        <meta name="description" content={seoDescription} />
      </Helmet>
      
      <div style={{ maxWidth: 800, margin: '60px auto', fontFamily: 'sans-serif', padding: 20 }}>
        <a href="/" style={{ display: 'inline-block', marginBottom: 20, color: '#4f46e5', textDecoration: 'none', fontWeight: 'bold' }}>
          &larr; Back to PDF Studio
        </a>
        
        <h1 style={{ fontSize: '36px', marginBottom: 10 }}>{title}</h1>
        <p style={{ fontSize: '18px', color: '#64748b', marginBottom: 40 }}>{description}</p>

        <div style={{ border: '2px dashed #cbd5e1', padding: '60px 40px', textAlign: 'center', borderRadius: 12, background: '#f8fafc' }}>
          <input 
            type="file" 
            accept={accept}
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ display: 'block', margin: '0 auto 20px auto', padding: '20px', border: '1px solid #e2e8f0', borderRadius: 8, background: 'white' }}
          />
          {file && <p style={{ fontSize: '16px', fontWeight: 'bold', color: '#334155' }}>Selected: {file.name}</p>}
          
          {error && <p style={{ color: '#ef4444', marginTop: 20 }}>{error}</p>}
          
          <button 
            onClick={handleProcess}
            disabled={!file || isLoading}
            style={{
              marginTop: 30,
              padding: '16px 32px',
              fontSize: '18px',
              fontWeight: 'bold',
              background: file && !isLoading ? '#10b981' : '#cbd5e1',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              cursor: file && !isLoading ? 'pointer' : 'not-allowed',
              transition: 'background 0.2s'
            }}
          >
            {isLoading ? 'Processing securely...' : buttonText}
          </button>
          
          <p style={{ marginTop: 20, fontSize: '13px', color: '#94a3b8' }}>
            🔒 Private & Secure. Files are processed locally or auto-deleted immediately.
          </p>
        </div>
      </div>
    </>
  );
}
