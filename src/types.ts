/* ============================================================
   Shared Types
   ============================================================ */

export type Point = { x: number; y: number }

export type CharStyle = {
  char: string
  fontSize: number
  fontColor: string
  fontStyle: string
  fontWeight: string
}

export type AnnotationType = 'text' | 'highlight' | 'ink' | 'rect' | 'ellipse' | 'line'

export type Annotation = {
  id: string
  type: AnnotationType
  page: number
  /** Position in PDF points (not pixels) */
  x: number
  y: number
  width: number
  height: number
  text?: string
  fontSize?: number
  fontColor?: string
  fontStyle?: string
  fontWeight?: string
  /** Character-level styling array */
  chars?: CharStyle[]
  /** Ink path — points relative to canvas origin, in PDF points */
  path?: Point[]
  /** Highlight colour */
  color?: string
  opacity?: number
  /** Shape properties */
  strokeColor?: string
  strokeWidth?: number
  fillColor?: string
  x2?: number // For lines
  y2?: number // For lines
}

export type ToolType = 'select' | 'edit' | 'text' | 'highlight' | 'ink' | 'pan' | 'rect' | 'ellipse' | 'line'
