import { Menu, type BrowserWindow } from 'electron'

/** Native editing actions for search boxes and other editable text fields. */
export function attachTextContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags
    Menu.buildFromTemplate([
      { role: 'cut', enabled: canCut },
      { role: 'copy', enabled: canCopy },
      { role: 'paste', enabled: canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: canSelectAll },
    ]).popup({ window: win, x: params.x, y: params.y })
  })
}
