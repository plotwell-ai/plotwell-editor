import { useEffect, useRef } from 'react'
import { PlotwellEditor } from '@plotwell/editor'
import '@plotwell/editor/styles.css'

interface EditorPreviewProps {
  content: string // Fountain format
  editable?: boolean
}

export function EditorPreview({ content, editable = false }: EditorPreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<PlotwellEditor | null>(null)

  useEffect(() => {
    if (!wrapRef.current) return

    editorRef.current = new PlotwellEditor({
      container: wrapRef.current, // must carry plotwell-editor-wrap class
      bubbleMenu: editable,
      typeBadge: true,
      darkMode: false,
      attribution: false,
    })

    if (content) {
      editorRef.current.importFountain(content)
    }

    if (!editable) {
      // Adds pw-reading-mode to ProseMirror: hides type badges + bubble menu,
      // sets caret-color: transparent
      editorRef.current.setReadingMode(true)
    }

    return () => {
      editorRef.current?.destroy()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable])

  // Update content without remounting
  useEffect(() => {
    if (editorRef.current && content) {
      editorRef.current.importFountain(content)
    }
  }, [content])

  return (
    // Outer gutter: #e5e5e5 matches editor's --pw-ui-bg default.
    // overflow-x-auto lets the 816px page scroll on narrow viewports instead of clipping.
    <div className="w-full overflow-x-auto" style={{ background: '#e5e5e5' }}>
      {/* This div IS the PlotwellEditor container — must have plotwell-editor-wrap */}
      <div
        ref={wrapRef}
        className="plotwell-editor-wrap pw-tool-preview"
      />
    </div>
  )
}
