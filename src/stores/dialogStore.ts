import { create } from 'zustand'

export interface ConfirmOpts {
  title: string
  message?: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  secondaryAction?: { label: string; onClick: () => void }
  danger?: boolean
}

export interface PromptOpts {
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
}

export interface AlertOpts {
  title: string
  message: string
  detail?: string
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean)       => void }
  | { kind: 'prompt';  opts: PromptOpts;  resolve: (v: string | null) => void }
  | { kind: 'alert';   opts: AlertOpts;   resolve: ()                 => void }

interface DialogStore {
  pending: Pending | null
  confirm: (opts: ConfirmOpts) => Promise<boolean>
  prompt:  (opts: PromptOpts)  => Promise<string | null>
  alert:   (opts: AlertOpts)   => Promise<void>
  settle:  (value: unknown)    => void
}

export const useDialogStore = create<DialogStore>((set, get) => ({
  pending: null,

  confirm: (opts) => new Promise(resolve => {
    if (get().pending) { resolve(false); return }
    set({ pending: { kind: 'confirm', opts, resolve } })
  }),

  prompt: (opts) => new Promise(resolve => {
    if (get().pending) { resolve(null); return }
    set({ pending: { kind: 'prompt', opts, resolve } })
  }),

  alert: (opts) => new Promise(resolve => {
    if (get().pending) { resolve(); return }
    set({ pending: { kind: 'alert', opts, resolve } })
  }),

  settle: (value) => {
    const d = get().pending
    if (!d) return
    set({ pending: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(d.resolve as (v: any) => void)(value)
  },
}))
