import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The frame every application screen uses, so the product reads as one thing rather than a pile of
 * separately styled pages.
 */
export function Page({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 p-6", className)}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}
