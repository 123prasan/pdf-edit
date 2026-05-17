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
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  pageWidth: number;
  pageHeight: number;
};

/* ------------------------------------------------------------------ *
 *  Two-phase extraction hook                                          *
 *  Phase 1: /extract-text (fast — text + colors, NO fonts)            *
 *  Phase 2: /extract-fonts (lazy background — embedded fonts only)    *
 * ------------------------------------------------------------------ */
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

    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

    /* ============================================================
       PHASE 1: Get text data instantly (no embedded fonts)
       Editor overlay appears as soon as this completes
       ============================================================ */
    const extractText = async () => {
      try {
        const formData = new FormData();
        formData.append('file', pdfFile);

        const res = await fetch(`${API_URL}/extract-text`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          throw new Error('Failed to extract text from PDF');
        }

        const json = await res.json();
        if (isMounted) {
          const parsedData: Record<number, ExtractedTextItem[]> = {};
          if (json.pages) {
            for (const key of Object.keys(json.pages)) {
              parsedData[parseInt(key, 10)] = json.pages[key];
            }
          }
          setData(parsedData);
          setLoading(false); // Editor is READY — overlay renders now
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message);
          setLoading(false);
        }
      }
    };

    /* ============================================================
       PHASE 2: Fetch embedded fonts in background (non-blocking)
       Silently injects @font-face rules for pixel-perfect rendering
       If it fails, fallback CSS fonts still look great
       ============================================================ */
    const extractFonts = async () => {
      try {
        const formData = new FormData();
        formData.append('file', pdfFile);

        const res = await fetch(`${API_URL}/extract-fonts`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) return; // Silently fail

        const json = await res.json();
        if (isMounted && json.embeddedFonts) {
          setEmbeddedFonts(json.embeddedFonts);
        }
      } catch {
        // Server slow or unreachable — CSS fallback fonts work fine
      }
    };

    // Fire Phase 1 first, then Phase 2 in background
    extractText().then(() => {
      if (isMounted) extractFonts();
    });

    return () => {
      isMounted = false;
    };
  }, [pdfFile]);

  return { data, embeddedFonts, loading, error };
}
