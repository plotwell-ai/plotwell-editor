import { useRef } from 'react'

export type SupportedFileType = '.txt' | '.fountain' | '.fdx' | '.docx' | '.md'

async function readDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target?.result as string || '')
    reader.onerror = reject
    reader.readAsText(file)
  })
}

function fdxToText(xml: string): string {
  // Extract readable text from Final Draft XML
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'text/xml')
  const paras = doc.querySelectorAll('Paragraph')
  const lines: string[] = []

  paras.forEach(para => {
    const type = para.getAttribute('Type') || ''
    const text = para.textContent?.trim() || ''
    if (!text) return

    switch (type) {
      case 'Scene Heading': lines.push(`\n${text.toUpperCase()}\n`); break
      case 'Action': lines.push(`\n${text}\n`); break
      case 'Character': lines.push(`\n${text.toUpperCase()}`); break
      case 'Dialogue': lines.push(text); break
      case 'Parenthetical': lines.push(`(${text.replace(/[()]/g, '')})`); break
      case 'Transition': lines.push(`\n${text.toUpperCase()}\n`); break
      default: lines.push(text)
    }
  })

  return lines.join('\n')
}

export function useFileImport(onContent: (text: string, filename: string) => void) {
  const inputRef = useRef<HTMLInputElement>(null)

  function open() {
    inputRef.current?.click()
  }

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      let text = ''
      const name = file.name.toLowerCase()

      if (name.endsWith('.docx')) {
        text = await readDocx(file)
      } else if (name.endsWith('.fdx')) {
        const xml = await readText(file)
        text = fdxToText(xml)
      } else {
        // .txt, .fountain, .md — plain text
        text = await readText(file)
      }

      onContent(text.trim(), file.name)
    } catch (err) {
      console.error('File import error:', err)
    }

    // Reset so same file can be re-imported
    e.target.value = ''
  }

  const inputEl = (
    <input
      ref={inputRef}
      type="file"
      accept=".txt,.fountain,.fdx,.docx,.md"
      onChange={handleChange}
      className="hidden"
    />
  )

  return { open, inputEl }
}
