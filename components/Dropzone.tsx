"use client";

import { useCallback, useState, useRef } from "react";
import { Upload, FolderOpen, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getExtension,
  getFormatInfo,
  FORMAT_REGISTRY,
} from "@/lib/formatRegistry";
import { cn, uid } from "@/lib/utils";
import type { ConvertibleFile } from "@/types/converter";
import { toast } from "sonner";

interface Props {
  onFilesAdded: (files: ConvertibleFile[]) => void;
}

function buildFile(file: File): ConvertibleFile | null {
  const ext = getExtension(file);
  const info = getFormatInfo(ext);
  if (!info || info.targets.length === 0) return null;
  return {
    id: uid(),
    file,
    inputFormat: ext,
    outputFormat: info.targets[0],
    status: "idle",
    progress: 0,
  };
}

type GroupedFormats = { label: string; exts: string[] }[];

function buildGroupedFormats(): GroupedFormats {
  const groupMap = new Map<string, string[]>();
  for (const [ext, info] of Object.entries(FORMAT_REGISTRY)) {
    if (!groupMap.has(info.group)) groupMap.set(info.group, []);
    groupMap.get(info.group)!.push(ext);
  }
  const ORDER = [
    "Image",
    "PDF",
    "Spreadsheet",
    "Document",
    "Data",
    "Archive",
    "Font",
    "Audio",
    "Video",
  ];
  return ORDER.filter((g) => groupMap.has(g)).map((g) => ({
    label: g,
    exts: groupMap.get(g)!,
  }));
}

const GROUPED_FORMATS: GroupedFormats = buildGroupedFormats();
const TOTAL_FORMATS = Object.keys(FORMAT_REGISTRY).length;

export function Dropzone({ onFilesAdded }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const process = useCallback(
    (raw: FileList | File[]) => {
      const all = Array.from(raw);
      const valid = all.map(buildFile).filter(Boolean) as ConvertibleFile[];
      const skipped = all.length - valid.length;

      if (valid.length > 0) onFilesAdded(valid);
      if (skipped > 0)
        toast.warning(
          `${skipped} unsupported file${skipped > 1 ? "s" : ""} skipped`,
        );
      if (valid.length > 0)
        toast.success(
          `${valid.length} file${valid.length > 1 ? "s" : ""} added`,
        );
    },
    [onFilesAdded],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      process(e.dataTransfer.files);
    },
    [process],
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node))
      setIsDragging(false);
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onClick={() => inputRef.current?.click()}
      className={cn(
        "relative rounded-2xl border-2 border-dashed cursor-pointer select-none",
        "flex flex-col items-center justify-center gap-3 sm:gap-4 py-10 sm:py-16 px-4 sm:px-8 text-center",
        "transition-all duration-200",
        isDragging
          ? "border-primary bg-primary/5 scale-[1.01]"
          : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/20",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) process(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        className={cn(
          "rounded-full p-3.5 sm:p-4 transition-colors",
          isDragging ? "bg-primary/10" : "bg-muted",
        )}
      >
        <Upload
          className={cn(
            "w-6 h-6 sm:w-7 sm:h-7 transition-colors",
            isDragging ? "text-primary" : "text-muted-foreground",
          )}
        />
      </div>

      <div className="space-y-1">
        <p className="font-semibold text-sm sm:text-base">
          {isDragging ? "Drop to add files" : "Tap or drag files here"}
        </p>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Any number of files — single or batch
        </p>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="gap-2 pointer-events-none"
        tabIndex={-1}
      >
        <FolderOpen className="w-3.5 h-3.5" />
        Browse files
      </Button>

      {/* Supported formats — collapsed by default */}
      <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Toggle trigger */}
        <button
          type="button"
          onClick={() => setFormatsOpen((o) => !o)}
          className={cn(
            "w-full flex items-center justify-center gap-1.5 pt-1",
            "text-[11px] text-muted-foreground/70 hover:text-muted-foreground",
            "transition-colors cursor-pointer",
          )}
          aria-expanded={formatsOpen}
        >
          <span>{TOTAL_FORMATS} supported formats</span>
          <ChevronDown
            className={cn(
              "w-3 h-3 transition-transform duration-200",
              formatsOpen && "rotate-180",
            )}
          />
        </button>

        {/* Collapsible format grid */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-300 ease-in-out",
            formatsOpen
              ? "max-h-[600px] opacity-100 mt-3"
              : "max-h-0 opacity-0 mt-0",
          )}
        >
          <div className="border-t border-dashed border-muted-foreground/20 pt-3 space-y-2 text-left">
            {GROUPED_FORMATS.map(({ label, exts }) => (
              <div key={label} className="flex gap-2 items-start">
                <span className="shrink-0 w-20 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50 pt-0.5 text-right leading-tight">
                  {label}
                </span>
                <div className="flex flex-wrap gap-1">
                  {exts.map((ext) => (
                    <span
                      key={ext}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-muted text-muted-foreground border border-border/60 leading-none"
                    >
                      .{ext}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
