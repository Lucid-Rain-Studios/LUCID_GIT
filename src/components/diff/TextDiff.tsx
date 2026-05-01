import React from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { DiffContent } from '@/ipc'

interface TextDiffProps {
  diff: DiffContent
}

export function TextDiff({ diff }: TextDiffProps) {
  return (
    <DiffEditor
      original={diff.oldContent}
      modified={diff.newContent}
      language={diff.language}
      theme="vs-dark"
      height="100%"
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontSize: 12,
        fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        wordWrap: 'off',
        renderOverviewRuler: false,
        scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
      }}
      loading={
        <div className="flex items-center justify-center h-full">
          <span className="text-xs font-mono text-lg-text-secondary animate-pulse">
            Loading diff…
          </span>
        </div>
      }
    />
  )
}
