import { useEffect, useRef } from "react"
import type { KeyboardEvent, ReactNode } from "react"

type Props = {
  open: boolean
  /** Uppercase eyebrow in the drawer head; also the dialog's accessible name. */
  title: string
  onClose: () => void
  children: ReactNode
  /** Stable id so owners can point aria-controls at the drawer. */
  id: string
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Right-side drawer (bottom sheet on phones) that stays mounted while closed
 * so what was typed survives a close. While open it is a modal dialog: focus
 * moves inside, Tab cycles inside, Escape and the scrim close it, and focus
 * returns to the control that opened it.
 */
export default function Drawer({ open, title, onClose, children, id }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    const panel = panelRef.current
    if (open && !wasOpen.current) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      wasOpen.current = true
      window.requestAnimationFrame(() => {
        const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
        ;(first ?? panel)?.focus()
      })
    } else if (!open && wasOpen.current) {
      wasOpen.current = false
      const opener = openerRef.current
      openerRef.current = null
      if (opener && opener.isConnected) opener.focus()
    }
  }, [open])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== "Tab" || !panelRef.current) return
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.offsetParent !== null || node === document.activeElement)
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <>
      <div className="dsc-scrim" hidden={!open} onClick={onClose} data-testid={`${id}-scrim`} />
      <div ref={panelRef} id={id} className="dsc-drawer" role="dialog" aria-modal="true" aria-label={title} hidden={!open} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dsc-drawer-head">
          <span className="dsc-drawer-title">{title}</span>
          <button type="button" className="icon-btn dsc-drawer-close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="dsc-drawer-body">{children}</div>
      </div>
    </>
  )
}
