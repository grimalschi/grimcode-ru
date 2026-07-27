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

/** A short explanation of why a screen is empty, in place of a blank area. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      {action}
    </div>
  )
}

/**
 * A failure the user can act on.
 *
 * Admin screens show what actually went wrong rather than a generic apology, because the reader is
 * an administrator who can usually do something about it.
 */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error)

  return (
    <div className="border-destructive/40 bg-destructive/5 flex flex-col items-start gap-3 rounded-lg border p-6">
      <p className="font-medium">Не загрузилось.</p>
      <p className="text-muted-foreground text-sm">{message}</p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="text-sm font-medium underline underline-offset-4"
        >
          Повторить
        </button>
      ) : null}
    </div>
  )
}
