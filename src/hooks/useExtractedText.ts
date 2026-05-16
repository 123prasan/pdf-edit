import { useState, useEffect } from 'react';

export type ExtractedTextItem = {
  page: number;
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  pageWidth: number;
  pageHeight: number;
};

export function useExtractedText(pdfFile: File | null) {
  const [data, setData] = useState<Record<number, ExtractedTextItem[]>>({});
  const [embeddedFonts, setEmbeddedFonts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pdfFile) {
      setData({});
      setEmbeddedFonts({});
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    const extractText = async () => {
      try {
        const formData = new FormData();
        formData.append('file', pdfFile);

        const res = await fetch('http://localhost:8000/extract-text', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          throw new Error('Failed to extract text from PDF');
        }

        const json = await res.json();
        if (isMounted) {
          // Parse the pages object, keys are stringified page numbers
          const parsedData: Record<number, ExtractedTextItem[]> = {};
          if (json.pages) {
            for (const key of Object.keys(json.pages)) {
              parsedData[parseInt(key, 10)] = json.pages[key];
            }
          }
          setData(parsedData);
          if (json.embeddedFonts) {
            setEmbeddedFonts(json.embeddedFonts);
          }
          setLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message);
          setLoading(false);
        }
      }
    };

    extractText();

    return () => {
      isMounted = false;
    };
  }, [pdfFile]);

  return { data, embeddedFonts, loading, error };
}
