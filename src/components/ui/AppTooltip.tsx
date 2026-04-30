import React from 'react'
import { Tooltip } from '@/components/ui/Tooltip'

interface AppTooltipProps {
  content: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  asSvgGroup?: boolean
}

export function AppTooltip({ content, children, side = 'top', delay = 250, asSvgGroup = false }: AppTooltipProps) {
  return (
    <Tooltip content={content} side={side} delay={delay} asSvgGroup={asSvgGroup}>
      {children}
    </Tooltip>
  )
}
