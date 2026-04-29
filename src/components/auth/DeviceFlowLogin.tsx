import React, { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { ipc } from '@/ipc'

interface DeviceFlowLoginProps {
  onClose: () => void
}

export function DeviceFlowLogin({ onClose }: DeviceFlowLoginProps) {
  const { deviceFlow, isLoading, isPolling, error, startDeviceFlow, pollOnce, clearDeviceFlow } =
    useAuthStore()

  const [copied, setCopied]           = useState(false)
  const [timeLeft, setTimeLeft]       = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Kick off the device flow on mount
  useEffect(() => {
    startDeviceFlow()
    return () => {
      clearDeviceFlow()
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Countdown timer
  useEffect(() => {
    if (!deviceFlow) return
    const tick = () =>
      setTimeLeft(Math.max(0, Math.floor((deviceFlow.expiresAt - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [deviceFlow?.expiresAt])

  // Poll GitHub once per interval
  useEffect(() => {
    if (!deviceFlow) return
    // +1 s buffer to avoid GitHub's slow_down error
    const ms = (deviceFlow.interval + 1) * 1000
    pollRef.current = setInterval(async () => {
      const done = await pollOnce()
      if (done) {
        if (pollRef.current) clearInterval(pollRef.current)
        onClose()
      }
    }, ms)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [deviceFlow?.deviceCode])

  const handleCopy = () => {
    if (!deviceFlow) return
    navigator.clipboard.writeText(deviceFlow.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleOpenGitHub = () => {
    if (deviceFlow) ipc.openExternal(deviceFlow.verificationUri)
  }

  const handleCloseRequest = () => {
    if (deviceFlow) {
      setConfirmClose(true)
    } else {
      clearDeviceFlow()
      onClose()
    }
  }

  const handleConfirmClose = () => {
    clearDeviceFlow()
    onClose()
  }

  const mins = timeLeft !== null ? Math.floor(timeLeft / 60) : 0
  const secs = timeLeft !== null ? String(timeLeft % 60).padStart(2, '0') : '00'

  const isActive = isLoading || !!deviceFlow

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <style>{`
        @keyframes lg-indeterminate {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(440px); }
        }
      `}</style>

      <div className="bg-lg-bg-secondary border border-lg-border rounded-lg w-[440px] shadow-2xl overflow-hidden">

        {/* Indeterminate progress bar — visible while flow is active */}
        <div className="h-0.5 w-full bg-lg-border/50 relative overflow-hidden">
          {isActive && (
            <div
              className="absolute h-full w-32 bg-lg-accent rounded-full"
              style={{ animation: 'lg-indeterminate 1.4s ease-in-out infinite' }}
            />
          )}
        </div>

        <div className="p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm font-bold text-lg-text-primary">
              Sign in with GitHub
            </span>
            <button
              onClick={handleCloseRequest}
              className="text-lg-text-secondary hover:text-lg-text-primary text-xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Close confirmation */}
          {confirmClose && (
            <div className="bg-lg-warning/10 border border-lg-warning/40 rounded-lg px-4 py-3 space-y-3">
              <p className="text-[11px] font-mono text-lg-warning leading-relaxed">
                Authorization is still in progress. Closing now will cancel sign-in and no token will be saved.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmClose(false)}
                  className="flex-1 h-7 rounded text-[11px] font-mono border border-lg-border text-lg-text-secondary hover:text-lg-text-primary hover:border-lg-accent transition-colors"
                >
                  Keep waiting
                </button>
                <button
                  onClick={handleConfirmClose}
                  className="flex-1 h-7 rounded text-[11px] font-mono border border-lg-warning/50 text-lg-warning hover:bg-lg-warning/10 transition-colors"
                >
                  Cancel sign-in
                </button>
              </div>
            </div>
          )}

          {/* Loading state */}
          {isLoading && !deviceFlow && (
            <div className="py-8 text-center">
              <span className="text-xs font-mono text-lg-text-secondary animate-pulse">
                Requesting authorization code…
              </span>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="bg-lg-error/10 border border-lg-error/40 rounded px-3 py-2 text-xs font-mono text-lg-error">
              {error}
            </div>
          )}

          {/* Active flow */}
          {deviceFlow && !confirmClose && (
            <>
              <p className="text-[11px] font-mono text-lg-text-secondary leading-relaxed">
                Copy the code below, then click <span className="text-lg-text-primary">Open GitHub</span> and
                enter it on the authorization page.
              </p>

              {/* Code display */}
              <div className="bg-lg-bg-primary border border-lg-border rounded-lg py-5 text-center select-all cursor-text">
                <span className="font-mono text-4xl font-bold tracking-[0.35em] text-lg-accent">
                  {deviceFlow.userCode}
                </span>
              </div>

              {/* Expiry countdown */}
              {timeLeft !== null && (
                <div className="text-center text-[10px] font-mono text-lg-text-secondary">
                  Expires in&nbsp;
                  <span className={timeLeft < 60 ? 'text-lg-warning' : ''}>
                    {mins}:{secs}
                  </span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  className="flex-1 h-8 rounded text-[11px] font-mono border border-lg-border text-lg-text-secondary hover:text-lg-text-primary hover:border-lg-accent transition-colors"
                >
                  {copied ? '✓ Copied!' : 'Copy code'}
                </button>
                <button
                  onClick={handleOpenGitHub}
                  className="flex-1 h-8 rounded text-[11px] font-mono bg-lg-accent text-white hover:bg-lg-accent/80 transition-colors"
                >
                  Open GitHub ↗
                </button>
              </div>

              {/* Polling status */}
              <div className="flex items-center gap-2 text-[10px] font-mono text-lg-text-secondary">
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                    isPolling ? 'bg-lg-accent animate-pulse' : 'bg-lg-border'
                  }`}
                />
                {isPolling ? 'Checking for authorization…' : 'Waiting for authorization…'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
