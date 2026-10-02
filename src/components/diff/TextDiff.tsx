import React, { useCallback, useEffect, useRef } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import { DiffContent } from '@/ipc'
import { DiffErrorBoundary } from './DiffErrorBoundary'
import { useAppearanceStore } from '@/stores/appearanceStore'
import { THEMES } from '@/lib/appearance'

interface TextDiffProps {
  diff: DiffContent
}

export function TextDiff({ diff }: TextDiffProps) {
  const settings = useAppearanceStore(s => s.settings)
  const monacoRef = useRef<Monaco | null>(null)
  const theme = THEMES.find(t => t.id === settings.theme) ?? THEMES[0]
  const applyTheme = useCallback((monaco: Monaco) => {
    monaco.editor.defineTheme('lucid-git', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: {
        'editor.background': theme.vars['--lg-bg-primary'],
        'editor.foreground': theme.vars['--lg-text-primary'],
        'editorLineNumber.foreground': theme.vars['--lg-text-secondary'],
      },
    })
    monaco.editor.setTheme('lucid-git')
  }, [theme])
  useEffect(() => {
    if (monacoRef.current) applyTheme(monacoRef.current)
  }, [applyTheme])
  // Keyed on what is being shown, so a failure clears when the file changes.
  const resetKey = `${diff.language}:${diff.oldContent.length}:${diff.newContent.length}`

  return (
    <DiffErrorBoundary resetKey={resetKey}>
    <DiffEditor
      original={diff.oldContent}
      modified={diff.newContent}
      language={diff.language}
      theme="lucid-git"
      beforeMount={monaco => { monacoRef.current = monaco; applyTheme(monaco) }}
      height="100%"
      options={{
        readOnly: true,
        renderSideBySide: true,
        fontSize: settings.fontSize ?? 13,
        fontFamily: `'${settings.codeFontFamily ?? 'Menlo'}', Consolas, monospace`,
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
    </DiffErrorBoundary>
  )
}
