"use client";

import { useState, useRef, useEffect, useCallback, useId } from "react";
import { ChevronDown, Check, Search } from "lucide-react";
import { FORMAT_GROUPS } from "@/lib/formatRegistry";
import { cn } from "@/lib/utils";

interface Props {
  targets: string[];
  value: string;
  onChange: (fmt: string) => void;
  disabled?: boolean;
}

// Build filtered + grouped options from the global registry
function buildGroups(targets: string[], query: string) {
  const q = query.trim().toLowerCase();
  return FORMAT_GROUPS.map((g) => ({
    label: g.label,
    options: g.formats.filter(
      (f) =>
        targets.includes(f) &&
        (!q || f.includes(q) || g.label.toLowerCase().includes(q)),
    ),
  })).filter((g) => g.options.length > 0);
}

// Portal rendered to document.body to escape any overflow:hidden ancestor
function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const { createPortal } = require("react-dom");
  return createPortal(children, document.body);
}

export function FormatSelector({ targets, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // Compute panel position anchored to trigger
  const [pos, setPos] = useState({
    top: 0,
    left: 0,
    width: 0,
    dir: "down" as "down" | "up",
  });

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const panelH = 320;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    const dir: "down" | "up" =
      spaceBelow >= panelH || spaceBelow >= spaceAbove ? "down" : "up";
    setPos({
      top:
        dir === "down"
          ? r.bottom + window.scrollY + 4
          : r.top + window.scrollY - panelH - 4,
      left: r.left + window.scrollX,
      width: Math.max(r.width, 176),
      dir,
    });
  }, []);

  // Open/close
  const openDropdown = useCallback(() => {
    if (disabled) return;
    reposition();
    setOpen(true);
    setQuery("");
    setHighlightedIndex(0);
  }, [disabled, reposition]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Focus search on open
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 10);
    }
  }, [open]);

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const handler = () => reposition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, reposition]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        closeDropdown();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, closeDropdown]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeDropdown();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, closeDropdown]);

  const groups = buildGroups(targets, query);
  // Flat list for keyboard nav
  const flatOptions = groups.flatMap((g) => g.options);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${highlightedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openDropdown();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, flatOptions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = flatOptions[highlightedIndex];
      if (chosen) {
        onChange(chosen);
        closeDropdown();
        triggerRef.current?.focus();
      }
    } else if (e.key === "Tab") {
      closeDropdown();
    }
  };

  const handleSelect = (fmt: string) => {
    onChange(fmt);
    closeDropdown();
    triggerRef.current?.focus();
  };

  const displayLabel = value ? `.${value.toUpperCase()}` : "Convert to…";
  const hasValue = !!value;

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Output format: ${displayLabel}`}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex items-center justify-between gap-1.5",
          "h-8 px-2.5 rounded-md border text-xs font-mono",
          "bg-background transition-colors select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled
            ? "opacity-50 cursor-not-allowed border-border"
            : "cursor-pointer border-border hover:border-foreground/40 hover:bg-muted/50",
          open && "border-foreground/40 bg-muted/30",
          "w-28 min-w-[7rem]",
        )}
      >
        <span
          className={cn(
            "truncate uppercase tracking-wide",
            !hasValue &&
              "text-muted-foreground normal-case tracking-normal font-sans",
          )}
        >
          {displayLabel}
        </span>
        <ChevronDown
          className={cn(
            "w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown panel — rendered in portal to escape overflow clipping */}
      {open && (
        <Portal>
          <div
            ref={panelRef}
            role="listbox"
            aria-labelledby={id}
            onKeyDown={handleKeyDown}
            style={{
              position: "absolute",
              top: pos.top,
              left: pos.left,
              width: pos.width,
              zIndex: 9999,
            }}
            className={cn(
              "rounded-lg border border-border bg-popover shadow-lg",
              "flex flex-col overflow-hidden",
              "animate-in fade-in-0 zoom-in-95 duration-100",
              pos.dir === "up" ? "origin-bottom" : "origin-top",
            )}
          >
            {/* Search box — always shown; useful when there are many targets */}
            <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
              <Search className="w-3 h-3 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlightedIndex(0);
                }}
                placeholder="Filter formats…"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground min-w-0"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setHighlightedIndex(0);
                    searchRef.current?.focus();
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  ×
                </button>
              )}
            </div>

            {/* Scrollable option list */}
            <div
              ref={listRef}
              className="overflow-y-auto overscroll-contain"
              style={{ maxHeight: 272 }}
            >
              {groups.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No formats match
                </p>
              ) : (
                groups.map((group) => {
                  return (
                    <div key={group.label}>
                      {/* Group label */}
                      <div className="sticky top-0 bg-popover/95 backdrop-blur-sm px-2.5 py-1 border-b border-border/50">
                        <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          {group.label}
                        </span>
                      </div>
                      {/* Options */}
                      <div className="py-0.5">
                        {group.options.map((fmt) => {
                          const idx = flatOptions.indexOf(fmt);
                          const isSelected = fmt === value;
                          const isHighlighted = idx === highlightedIndex;
                          return (
                            <button
                              key={fmt}
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              data-idx={idx}
                              onClick={() => handleSelect(fmt)}
                              onMouseEnter={() => setHighlightedIndex(idx)}
                              className={cn(
                                "w-full flex items-center justify-between gap-2",
                                "px-2.5 py-1.5 text-xs font-mono uppercase text-left",
                                "transition-colors cursor-pointer",
                                isHighlighted && !isSelected && "bg-muted",
                                isSelected &&
                                  "bg-primary text-primary-foreground",
                                !isHighlighted &&
                                  !isSelected &&
                                  "text-foreground",
                              )}
                            >
                              <span>.{fmt}</span>
                              {isSelected && (
                                <Check className="w-3 h-3 shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
