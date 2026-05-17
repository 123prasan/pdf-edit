import { useState, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';

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

// ------------------------------------------------------------------
// Font normalizer (mirrors server)
// ------------------------------------------------------------------
const SERIF_KW = ['times', 'georgia', 'garamond', 'palatino', 'bookman', 'minion', 'cambria', 'didot', 'caslon', 'baskerville', 'bodoni', 'rockwell', 'merriweather', 'playfair', 'lora'];
const MONO_KW = ['courier', 'consolas', 'inconsolata', 'menlo', 'monaco', 'sourcecodepro', 'mono', 'typewriter'];

function classifyFont(raw: string): { cssFamily: string; fontWeight: string; fontStyle: string } {
  const stripped = raw.replace(/^[A-Z]{6}\+/, '');
  const lower = stripped.toLowerCase().replace(/[\s\-_]/g, '');

  let fontWeight = 'normal';
  if (/bold|black|heavy|semibold/i.test(lower)) fontWeight = 'bold';
  let fontStyle = 'normal';
  if (/italic|oblique|slanted|it$/i.test(lower)) fontStyle = 'italic';

  let genericFamily = 'sans-serif';
  if (SERIF_KW.some(kw => lower.includes(kw))) genericFamily = 'serif';
  else if (MONO_KW.some(kw => lower.includes(kw))) genericFamily = 'monospace';

  let cssFamily = '"Helvetica Neue", Arial, sans-serif';
  if (genericFamily === 'serif') cssFamily = '"Times New Roman", Times, serif';
  if (genericFamily === 'monospace') cssFamily = '"Courier New", Courier, monospace';

  return { cssFamily: `"${stripped}", ${cssFamily}`, fontWeight, fontStyle };
}

// ------------------------------------------------------------------
// The holy grail: Client-side span merger (fixes pdf.js fragmentation)
// ------------------------------------------------------------------
function mergeTextItems(items: any[]): any[] {
  if (items.length === 0) return [];

  const merged: any[] = [];
  let current = { ...items[0] };

  for (let i = 1; i < items.length; i++) {
    const next = items[i];

    // Check if they are on the exact same line (y-axis) and have the same font/size
    const sameLine = Math.abs(current.y - next.y) < 2;
    const sameFont = current.fontName === next.fontName && Math.abs(current.fontSize - next.fontSize) < 1;

    // Check if they are horizontally adjacent (with a small tolerance for spaces)
    // pdf.js sometimes adds spaces, sometimes it's just physical distance
    const distance = next.x - (current.x + current.width);
    const isAdjacent = distance > -2 && distance < (current.fontSize * 0.4);

    if (sameLine && sameFont && isAdjacent) {
      // Merge them!
      // If there's a physical gap large enough to be a space, but no space character, add one
      if (distance > current.fontSize * 0.15 && !current.str.endsWith(' ') && !next.str.startsWith(' ')) {
        current.str += ' ';
        current.width += (distance); // Add the space width
      }

      current.str += next.str;
      current.width = (next.x + next.width) - current.x; // Extend bounding box
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

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

    // ============================================================
    // INSTANT PHASE: Local browser extraction (0 network wait)
    // ============================================================
    const extractClientSide = async () => {
      try {
        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const result: Record<number, ExtractedTextItem[]> = {};

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
          if (!isMounted) return;
          const pdfPage = await pdfDoc.getPage(pageNum);
          const viewport = pdfPage.getViewport({ scale: 1.0 });
          const textContent = await pdfPage.getTextContent({ includeMarkedContent: false });
          const styles = (textContent as any).styles || {};

          let rawItems: any[] = [];

          for (const item of textContent.items) {
            const textItem = item as any;
            if (!textItem.str || !textItem.str.trim()) continue;

            const tx = textItem.transform;
            const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
            const x = tx[4];
            const y = viewport.height - tx[5] - fontSize;

            const fontName = textItem.fontName || '';
            const rawFontName = styles[fontName]?.fontFamily || fontName;
            const fontInfo = classifyFont(rawFontName);

            rawItems.push({
              page: pageNum,
              str: textItem.str,
              x, y, width: textItem.width, height: textItem.height || fontSize * 1.2,
              fontSize,
              fontName: rawFontName,
              fontFamily: fontInfo.cssFamily,
              fontWeight: fontInfo.fontWeight,
              fontStyle: fontInfo.fontStyle,
              color: '#000000', // Default black, patched by server later
              pageWidth: viewport.width,
              pageHeight: viewport.height,
            });
          }

          // Merge fragmented characters into full words for click-to-edit!
          result[pageNum] = mergeTextItems(rawItems);
        }

        if (isMounted) {
          setData(result);
          setLoading(false); // EDITOR IS READY INSTANTLY
        }

        // ============================================================
        // BACKGROUND PHASE: Fetch accurate colors & embedded fonts
        // ============================================================
        const formData = new FormData();
        formData.append('file', pdfFile);

        // 1. Fetch accurate colors
        fetch(`${API_URL}/extract-colors`, { method: 'POST', body: formData })
          .then(res => res.json())
          .then(json => {
            if (!isMounted || !json.pages) return;
            setData(prev => {
              const enriched = { ...prev };
              for (const pageKey of Object.keys(prev)) {
                const pageNum = parseInt(pageKey, 10);
                const serverItems = json.pages[pageKey] || [];
                enriched[pageNum] = prev[pageNum].map(item => {
                  // Bounding Box Intersection Match!
                  // item is the pdf.js word. si is the PyMuPDF span (could be a full sentence).
                  const match = serverItems.find((si: any) => {
                    const verticalMatch = Math.abs(si.y - item.y) < 5 || (item.y >= si.y - 2 && item.y <= si.y + si.height + 2);
                    const horizontalMatch = item.x >= si.x - 5 && item.x <= si.x + si.width + 5;
                    return verticalMatch && horizontalMatch;
                  });
                  if (match) {
                    return {
                      ...item,
                      color: match.color,
                      fontFamily: match.fontFamily,
                      fontName: match.fontName,
                      fontWeight: match.fontWeight,
                      fontStyle: match.fontStyle
                    };
                  }
                  return item;
                });
              }
              return enriched;
            });
          }).catch(() => { }); // Silently fail if server down

        // 2. Fetch embedded fonts for pixel-perfect rendering
        fetch(`${API_URL}/extract-fonts`, { method: 'POST', body: formData })
          .then(res => res.json())
          .then(json => {
            if (isMounted && json.embeddedFonts) setEmbeddedFonts(json.embeddedFonts);
          }).catch(() => { });

      } catch (err: any) {
        if (isMounted) {
          setError(err.message);
          setLoading(false);
        }
      }
    };

    extractClientSide();

    return () => { isMounted = false; };
  }, [pdfFile]);

  return { data, embeddedFonts, loading, error };
}
